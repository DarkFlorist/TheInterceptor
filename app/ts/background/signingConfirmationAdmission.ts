import * as funtypes from 'funtypes'
import { getSafePendingFlow } from '../safe/safePendingFlow.js'
import { verifyDirectResult } from '../signing/backend.js'
import { invalidSigningResponse, isInvalidSigningResponse } from '../signing/exactPayload.js'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { TokenPriceService } from '../simulation/services/priceEstimator.js'
import type { PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import { EIP712Message } from '../types/eip721.js'
import type { TransactionConfirmation } from '../types/interceptor-messages.js'
import type { SendRawTransactionParams, SendTransactionParams } from '../types/JsonRpc-types.js'
import type { SignMessageParams } from '../types/jsonRpc-signing-types.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { getErrorMessage } from '../utils/errors.js'
import { doesUniqueRequestIdentifiersMatch } from '../utils/requests.js'
import { prepareSavedBrowserWalletForwarding } from './browserWalletForwarding.js'
import { openDirectSigning, readDirectSigningRecords } from './directSigning.js'
import { getSigningWalletBinding } from './storageVariables.js'

type SigningAdmission =
	| { readonly status: 'continue', readonly forwarding: { readonly expectedProviderId?: string } }
	| { readonly status: 'directSigningOpened' }
	| { readonly status: 'blocked', readonly error?: { readonly code: number, readonly message: string } }

const selectionFailure = (message: string): SigningAdmission => ({ status: 'blocked', error: { code: 4100, message } })

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
			return forwarding.error === undefined
				? { status: 'continue', forwarding: { expectedProviderId: forwarding.expectedProviderId } }
				: { status: 'blocked', error: forwarding.error }
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
		if (record === undefined || expected !== confirmation.signerReply || !(record.input.method === 'eth_sendTransaction' ? ['submitted', 'confirmed'].includes(record.phase) : record.phase === 'signed')) return { status: 'blocked' }
	} else if (getSafePendingFlow(pending) === undefined && (request.method === 'personal_sign' || request.method === 'eth_signTypedData_v4')) {
		try {
			if (typeof confirmation.signerReply !== 'string') throw invalidSigningResponse('Browser wallet returned a non-string message signature')
			await verifyDirectResult({ method: request.method, data: request.method === 'personal_sign' ? request.params[0] : funtypes.String.parse(EIP712Message.serialize(request.params[1])), address: `0x${ binding.wallet.address.toString(16).padStart(40, '0') }`, chainId: pending.signingChainId ?? ethereum.getChainId() }, confirmation.signerReply)
		} catch (error) {
			if (!isInvalidSigningResponse(error)) throw error
			return selectionFailure(getErrorMessage(error) ?? 'Unable to verify wallet signature')
		}
	}
	return { status: 'continue', forwarding: {} }
}
