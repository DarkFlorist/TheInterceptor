import { isSigningOperationError } from '../signing/signingOperationError.js'
import type { SigningRecordReply } from '../types/signingPageReply.js'
import { isSignatureReadyForApplication } from '../signing/signingProgress.js'
import type { DirectSigningRecord, DirectSigningRequest } from '../types/directSigning.js'
import { getSafePendingFlow } from '../safe/safePendingFlow.js'
import { invalidSigningResponse, isInvalidSigningResponse, verifyBrowserWalletMessageSignature } from '../signing/exactPayload.js'
import { addressString } from '../utils/bigint.js'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { TokenPriceService } from '../simulation/services/priceEstimator.js'
import type { PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import type { TransactionConfirmation } from '../types/interceptor-messages.js'
import type { SendRawTransactionParams, SendTransactionParams } from '../types/JsonRpc-types.js'
import type { SignMessageParams } from '../types/jsonRpc-signing-types.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { getErrorMessage } from '../utils/errors.js'
import { doesUniqueRequestIdentifiersMatch } from '../utils/requests.js'
import { getPendingTransactionsAndMessages, getTabState } from './storageVariables.js'
import { prepareSavedBrowserWalletForwarding } from './browserWalletForwarding.js'
import { openDirectSigning, updateDirectSigning, refreshDirectSigningReview } from './directSigning.js'
import { getSigningWalletBinding } from './signingAddressBookCoordinator.js'
import { readDirectSigningRecords } from '../signing/directSigningStore.js'

type SigningAdmission =
	| { readonly status: 'continue', readonly forwarding: { readonly expectedProviderId?: string, readonly expectedChainId?: bigint } }
	| { readonly status: 'directSigningOpened' }
	| { readonly status: 'blocked', readonly error?: { readonly code: number, readonly message: string } }

const selectionFailure = (message: string): SigningAdmission => ({ status: 'blocked', error: { code: 4100, message } })

export const getWalletChainMismatchMessage = (walletChainId: bigint, reviewedChainId: bigint) => `Your wallet is on chain ${ walletChainId.toString() }, but this transaction was reviewed on chain ${ reviewedChainId.toString() }. Switch your wallet back to chain ${ reviewedChainId.toString() }, then approve again.`

/** Resolve the reviewed binding before the window controller forwards or completes a request. Unexpected failures propagate to its diagnostic path. */
export async function resolveSigningConfirmationAdmission(
	ethereum: EthereumClientService,
	prices: TokenPriceService,
	connections: WebsiteTabConnections,
	pending: PendingTransactionOrSignableMessage,
	confirmation: TransactionConfirmation['data'],
	request: SendTransactionParams | SendRawTransactionParams | SignMessageParams,
): Promise<SigningAdmission> {
	const binding = pending.signingWalletBinding
	if (pending.simulationMode || binding === undefined) return { status: 'continue', forwarding: {} }
	if (confirmation.action === 'accept') {
		if (binding.wallet.type === 'browser') {
			// Browser forwarding checks the revision after any asynchronous account discovery.
			const forwarding = await prepareSavedBrowserWalletForwarding(connections, pending.uniqueRequestIdentifier.requestSocket, binding)
			if (forwarding.error !== undefined) return { status: 'blocked', error: forwarding.error }
			if (request.method !== 'eth_sendTransaction') return { status: 'continue', forwarding: { expectedProviderId: forwarding.expectedProviderId } }
			// A saved address does not follow the wallet's chain changes, so the wallet can be on another chain than the one this transaction was simulated on. Refuse a known mismatch here; the page checks the wallet's chain again right before forwarding.
			const reviewedChainId = pending.signingChainId ?? ethereum.getChainId()
			const walletChainId = (await getTabState(pending.uniqueRequestIdentifier.requestSocket.tabId)).signerChain
			if (walletChainId !== undefined && walletChainId !== reviewedChainId) return selectionFailure(getWalletChainMismatchMessage(walletChainId, reviewedChainId))
			return { status: 'continue', forwarding: { expectedProviderId: forwarding.expectedProviderId, expectedChainId: reviewedChainId } }
		}
		if ((await getSigningWalletBinding(binding.wallet.address))?.revision !== binding.revision) return selectionFailure('Signing wallet changed. Reject this request and review a new request.')
		if (request.method === 'eth_sendRawTransaction') return selectionFailure('Direct wallets do not sign raw transactions')
		await openDirectSigning(ethereum, prices, pending, request)
		return { status: 'directSigningOpened' }
	}
	if (confirmation.action !== 'signerIncluded') return { status: 'continue', forwarding: {} }
	if (binding.wallet.type !== 'browser') {
		const record = (await readDirectSigningRecords()).find((item) => doesUniqueRequestIdentifiersMatch(item.request, pending.uniqueRequestIdentifier))
		const expected = record?.input.method === 'eth_sendTransaction' ? record.transactionHash : record?.result
		if (record === undefined || expected !== confirmation.signerReply || !isSignatureReadyForApplication(record)) return { status: 'blocked' }
	} else if (getSafePendingFlow(pending) === undefined && (request.method === 'personal_sign' || request.method === 'eth_signTypedData_v4')) {
		try {
			if (typeof confirmation.signerReply !== 'string') throw invalidSigningResponse('Browser wallet returned a non-string message signature')
			await verifyBrowserWalletMessageSignature(request.method === 'personal_sign' ? { method: 'personal_sign', message: request.params[0] } : { method: 'eth_signTypedData_v4', typedData: request.params[1] }, addressString(binding.wallet.address), confirmation.signerReply)
		} catch (error) {
			if (!isInvalidSigningResponse(error)) throw error
			return selectionFailure(getErrorMessage(error) ?? 'Unable to verify wallet signature')
		}
	}
	return { status: 'continue', forwarding: {} }
}

type DirectSigningOutcome = {
	readonly reply: SigningRecordReply
	readonly confirmation?: TransactionConfirmation
	readonly refreshConfirmation?: boolean
}

/** Both confirmation admission and signing-page transitions enter this coordinator; callers apply its window effects. */
export async function advanceDirectSigning(request: DirectSigningRequest, ethereum: EthereumClientService, prices: TokenPriceService): Promise<DirectSigningOutcome> {
	try {
		const record = await updateDirectSigning(request, async (edited) => await refreshDirectSigningReview(edited, ethereum, prices))
		const confirmation: TransactionConfirmation | undefined = record.phase === 'cancelled'
			? { method: 'popup_confirmDialog', data: { action: 'reject', errorString: undefined, uniqueRequestIdentifier: record.request } }
			: isSignatureReadyForApplication(record)
				? { method: 'popup_confirmDialog', data: { action: 'signerIncluded', uniqueRequestIdentifier: record.request, signerReply: record.input.method === 'eth_sendTransaction' ? record.transactionHash : record.result } }
				: undefined
		return { reply: { ok: true, record }, confirmation, refreshConfirmation: request.method === 'signing_editFees' }
	} catch (error) {
		if (!isSigningOperationError(error) && !isInvalidSigningResponse(error)) throw error
		return { reply: { ok: false, message: error.message } }
	}
}

/** Why Interceptor refused to return this record's signature to the website, read from the website request's stored signer error so that a reloaded signing page shows it too. Undefined while the signature is not ready for the website, and once the website request is resolved. */
export async function getSignatureRefusalReason(record: DirectSigningRecord) {
	if (!isSignatureReadyForApplication(record)) return undefined
	const pending = (await getPendingTransactionsAndMessages()).find((item) => doesUniqueRequestIdentifiersMatch(item.uniqueRequestIdentifier, record.request))
	return pending?.approvalStatus.status === 'SignerError' ? pending.approvalStatus.message : undefined
}
