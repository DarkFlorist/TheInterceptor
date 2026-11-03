import type { MessageConfirmationRequest, TransactionConfirmationRequest } from '../../types/confirmationRequest.js'
import { SafeMessage } from '../../safe/safeMessage.js'
import { isSafeMessageCoSignRequest } from '../../safe/safeRequestPolicy.js'
import type { EthereumClientService } from '../../simulation/services/EthereumClientService.js'
import { getInputFieldFromDataOrInput, getSimulatedBalance, getSimulatedErc20Balance, getSimulatedTransactionCount, simulateEstimateGas } from '../../simulation/services/SimulationModeEthereumClientService.js'
import { simulatePersonalSign } from '../../simulation/services/simulationPersonalSigning.js'
import { getSignedTransactionForSimulation } from '../../simulation/services/simulationTransactionSigning.js'
import { CANNOT_SIMULATE_OFF_LEGACY_BLOCK, ERROR_INTERCEPTOR_NO_ACTIVE_ADDRESS, METAMASK_ERROR_BLANKET_ERROR, METAMASK_ERROR_FAILED_TO_PARSE_REQUEST, METAMASK_ERROR_USER_REJECTED_REQUEST } from '../../utils/constants.js'
import { type SignerReply, type TransactionConfirmation, UpdateConfirmTransactionDialog, UpdateConfirmTransactionDialogPendingTransactions } from '../../types/interceptor-messages.js'
import { Semaphore } from '../../utils/semaphore.js'
import type { WebsiteTabConnections } from '../../types/user-interface-types.js'
import { type InterceptorTransactionStack, PASSTHROUGH_STATE, type TransactionGasPayment, type TransactionSimulationOptions, type WebsiteCreatedEthereumTransaction, type WebsiteCreatedEthereumTransactionOrFailed, createPassthroughCompleteVisualizedSimulation } from '../../types/visualizer-types.js'
import type { SendRawTransactionParams, SendTransactionParams } from '../../types/JsonRpc-types.js'
import { refreshConfirmTransactionSimulation } from '../confirmTransactionSimulation.js'
import { captureSimulationSnapshot, getExecutedCallFormation, getUpdatedSimulationState } from '../simulationUpdating.js'
import { getHtmlFile, sendPopupMessageToOpenWindows } from '../backgroundUtils.js'
import { appendPendingTransactionOrMessage, deferSignatureUnlessAnswered, getInterceptorTransactionStack, getPendingSafeProposalStores, getPendingTransactionsAndMessages, movePendingSafeProposalToOutbox, removePendingSafeProposalStore, getRpcConnectionStatus, getTabState, getUserAddressBookEntriesForChainIdMorePreciseFirst, removePendingTransactionOrMessage, updateInterceptorTransactionStack, updatePendingTransactionOrMessage } from '../storageVariables.js'
import { type InterceptedRequest, type UniqueRequestIdentifier, doesUniqueRequestIdentifiersMatch, getUniqueRequestIdentifierString, silenceChromeUnCaughtPromise } from '../../utils/requests.js'
import { replyToInterceptedRequestAfterManifestV2Reconnect } from '../messageSending.js'
import { attemptQueuedTerminalReplyDelivery, deliverQueuedTerminalReplyOnce, queueSafeProposalReplyAndMoveToOutbox, queueTerminalReplyUnlessDeferred, releaseTerminalReplyReservation } from '../terminalReplyDelivery.js'
import { getPendingTerminalReplies, prunePendingTerminalRepliesForMissingTabs } from '../pendingTerminalReplies.js'
import { getConfirmationWindowRequests } from '../../utils/confirmationQueue.js'
import { isAbiDataDecodeError, stringToBytes, keccak256 } from '../../utils/ethereumPrimitives.js'
import { EthereumBytes32, EthereumQuantity, serialize } from '../../types/wire-types.js'
import type { PopupOrTabId, Website } from '../../types/websiteAccessTypes.js'
import { getErrorMessage, JsonRpcResponseError, reportUnexpectedError, isExpectedInfrastructureError, isNewBlockAbort, reportLocalRecovery } from '../../utils/errors.js'
import type { PendingSafeProposalStore, PendingTransactionOrSignableMessage, PopupPendingTransactionOrSignableMessage } from '../../types/accessRequest.js'
import type { SignMessageParams } from '../../types/jsonRpc-signing-types.js'
import type { InterceptedRequestForward } from '../../types/interceptor-messages.js'
import type { SimulationStackChange } from '../../types/visualizer-types.js'
import type { SafeSignerErrorDetails } from '../../types/safeTypes.js'
import { craftPersonalSignPopupMessage } from './personalSign.js'
import { getSettingsSnapshot, requireAvailableSettings } from '../settings.js'
import * as funtypes from 'funtypes'
import { assertNever, modifyObject } from '../../utils/typescript.js'
import { simulateGnosisSafeTransactionOnPass } from '../popupMessageHandlers.js'
import { updatePopupVisualisationIfNeeded } from '../popupVisualisationUpdater.js'
import { POPUP_PERFORMANCE_MARKS, markPerformance } from '../../utils/popupPerformance.js'
import type { TokenPriceService } from '../../simulation/services/priceEstimator.js'
import { closePopupOrTabById, getPopupOrTabById, openPopupOrTab, tryFocusingTabOrWindow } from '../../utils/popupOrTab.js'
import { getDesiredMaxFeePerGasForBaseFee, getTransactionFeesForBaseFee, hasExplicitMaxFeePerGas } from '../../utils/transactionFees.js'
import { parseSendRawTransaction } from '../../utils/sendRawTransactionParsing.js'
import { createEip1559Or7702Transaction } from '../../utils/eip7702Authorization.js'
import { identifyAddress } from '../metadataUtils.js'
import { resolveInsufficientBalanceMessage } from '../../utils/insufficientBalance.js'
import { prepareSafeTransactionConfirmation } from '../safeTransactionConfirmation.js'
import { createSafeMessageCoSignSnapshot, getPendingSafeSignerAddress, getSafeSignerMismatchApprovalStatus, isExpectedSafeMessageCoSignSnapshotFailure, isSafeMessageAccountMismatchFailure, isSafeSignerSelectionFailure, resolveSafeConfirmation, SAFE_SIGNER_SELECTION_ERROR_CODE, type RefreshedSafeSignerSelection } from '../safeConfirmationResolver.js'
import { createSafeOffChainMessageSnapshot, refreshAndPersistSafeSignerSelection } from '../safeSignerSelectionRefresh.js'
import { getSafePendingFlow } from '../../safe/safePendingFlow.js'
import { persistUnsignedSafeTransaction, resolveSafeSignerReply } from '../safeConfirmationPersistence.js'
import { getWalletSelectedAccount } from '../../utils/activeAddressSelection.js'
import { createSafeSignerErrorStatus } from '../safeSignerErrors.js'
import { RPC_CONFIGURATION_UNAVAILABLE_ERROR } from '../../types/interceptor-reply-messages.js'

const pendingConfirmationSemaphore = new Semaphore(1)
const pendingNoResponseRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const NO_RESPONSE_RETRY_DELAY_MS = 50

// Shows a proposal that was just stored in the Gnosis Safe stack: the simulation is refreshed with it and the simulation stack window opens, where the user continues with the proposal.
async function showStoredSafeProposal(ethereum: EthereumClientService, tokenPriceService: TokenPriceService) {
	await updatePopupVisualisationIfNeeded(ethereum, tokenPriceService, { invalidateOldState: true })
	await openPopupOrTab({ url: getHtmlFile('simulationStack') })
}

// Shows how resolving a request changed the simulation stack. Every outcome is handled here, so a new outcome fails typecheck until it is given its view work.
async function showSimulationStackChange(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, simulationStack: SimulationStackChange) {
	switch (simulationStack) {
		case 'unchanged': return
		case 'changed': {
			await updatePopupVisualisationIfNeeded(ethereum, tokenPriceService)
			return
		}
		case 'safeProposalStored': {
			await showStoredSafeProposal(ethereum, tokenPriceService)
			return
		}
		default: assertNever(simulationStack)
	}
}

// Runs one step of the confirmation window work done after a request is resolved. A failing step is reported and does not skip the steps after it, so the window is still updated and closed.
async function runConfirmationViewStep(step: () => Promise<unknown>) {
	try {
		await step()
	} catch (error: unknown) {
		await reportUnexpectedError(error, { code: 'confirm_transaction_view_update_failed' })
	}
}

async function refreshDirectSafeExecutionSimulation(
	ethereum: EthereumClientService,
	tokenPriceService: TokenPriceService,
	pending: PendingTransactionOrSignableMessage,
): Promise<PendingTransactionOrSignableMessage> {
	const flow = getSafePendingFlow(pending)
	if (flow?.kind !== 'directExecution') return pending
	pending = flow.pending
	const originalRequestParameters = pending.originalRequestParameters
	if (originalRequestParameters.method !== 'eth_sendTransaction') return pending
	const transactionToSimulate = await formEthSendTransaction(
		ethereum,
		undefined,
		pending.activeAddress,
		pending.website,
		originalRequestParameters,
		pending.created,
		pending.transactionIdentifier,
		false,
		'external-executor',
	)
	const popupVisualisation = await refreshConfirmTransactionSimulation(
		ethereum,
		tokenPriceService,
		pending.activeAddress,
		false,
		pending.uniqueRequestIdentifier,
		transactionToSimulate,
	)
	if (popupVisualisation === undefined) throw new Error('The refreshed Gnosis Safe execution simulation did not complete.')
	return transactionToSimulate.success
		? { ...pending, transactionToSimulate, popupVisualisation, transactionOrMessageCreationStatus: 'Simulated' }
		: { ...pending, transactionToSimulate, popupVisualisation, transactionOrMessageCreationStatus: 'FailedToSimulate' }
}

export async function refreshPendingSafeSignerSelectionErrors(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, tabId: number) {
	const tabState = await getTabState(tabId)
	const refreshedSelection = {
		selectedSigner: getWalletSelectedAccount(tabState),
		verificationError: undefined,
	}
	let pendingStateChanged = false
	for (const pending of await getPendingTransactionsAndMessages()) {
		const safeSignerAddress = getPendingSafeSignerAddress(pending)
		if (pending.uniqueRequestIdentifier.requestSocket.tabId !== tabId) continue
		if (refreshedSelection.selectedSigner !== undefined) {
			const refresh = await refreshAndPersistSafeSignerSelection(
				ethereum,
				pending,
				refreshedSelection.selectedSigner,
				async (refreshedPending) => await refreshDirectSafeExecutionSimulation(ethereum, tokenPriceService, refreshedPending),
			)
			if (refresh.persisted) pendingStateChanged = true
			if (refresh.refreshRequired && refresh.refreshResult.status !== 'unchanged') continue
		}
		if (
			safeSignerAddress === undefined
			|| pending.uniqueRequestIdentifier.requestSocket.tabId !== tabId
			|| pending.approvalStatus.status === 'WaitingForSigner'
			|| pending.approvalStatus.status === 'SignerError' && pending.approvalStatus.code !== SAFE_SIGNER_SELECTION_ERROR_CODE
		) continue
		const signerMismatch = await getSafeSignerMismatchApprovalStatus(tabId, safeSignerAddress, refreshedSelection)
		if (pending.approvalStatus.status === 'WaitingForUser' && signerMismatch === undefined) continue
		await updatePendingTransactionOrMessage(pending.uniqueRequestIdentifier, async (current) => {
			if (current.approvalStatus.status === 'WaitingForSigner') return current
			if (current.approvalStatus.status === 'SignerError' && current.approvalStatus.code !== SAFE_SIGNER_SELECTION_ERROR_CODE) return current
			pendingStateChanged = true
			return modifyObject(current, {
				approvalStatus: signerMismatch ?? { status: 'WaitingForUser' as const },
			})
		})
	}
	if (pendingStateChanged) await updateConfirmTransactionView(ethereum, tokenPriceService)
}

type TimestampedPopupVisualisation = {
	statusCode: 'success' | 'failed'
	data: {
		simulationStartedTimestamp: Date
		simulationState: {
			simulationConductedTimestamp: Date
		}
	}
}

const getSimulationStartedTimestamp = (popupVisualisation: TimestampedPopupVisualisation) => popupVisualisation.data.simulationStartedTimestamp

const shouldReplacePopupVisualisation = (
	currentPopupVisualisation: TimestampedPopupVisualisation | undefined,
	nextPopupVisualisation: TimestampedPopupVisualisation,
) => {
	const currentTimestamp = currentPopupVisualisation === undefined ? undefined : getSimulationStartedTimestamp(currentPopupVisualisation)
	const nextTimestamp = getSimulationStartedTimestamp(nextPopupVisualisation)
	if (currentTimestamp === undefined || nextTimestamp === undefined) return true
	return nextTimestamp.getTime() >= currentTimestamp.getTime()
}

export function toPopupPendingTransactionOrSignableMessage(pending: PendingTransactionOrSignableMessage): PopupPendingTransactionOrSignableMessage {
	switch (pending.type) {
		case 'Transaction':
			return pending
		case 'SignableMessage': {
			const base = {
				type: pending.type,
				popupOrTabId: pending.popupOrTabId,
				originalRequestParameters: pending.originalRequestParameters,
				simulationMode: pending.simulationMode,
				uniqueRequestIdentifier: pending.uniqueRequestIdentifier,
				created: pending.created,
				website: pending.website,
				activeAddress: pending.activeAddress,
				approvalStatus: pending.approvalStatus,
			}
			const transactionOrMessageCreationStatus = pending.transactionOrMessageCreationStatus
			switch (transactionOrMessageCreationStatus) {
				case 'Simulated':
					return {
						...base,
						transactionOrMessageCreationStatus,
						visualizedPersonalSignRequest: pending.visualizedPersonalSignRequest,
					}
				case 'Crafting':
				case 'Simulating':
					return {
						...base,
						transactionOrMessageCreationStatus,
					}
				default:
					return assertNever(transactionOrMessageCreationStatus)
			}
		}
		default:
			return assertNever(pending)
	}
}

export async function updateConfirmTransactionView(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, onlyIfNotAlreadyUpdating = false) {
	try {
		const currentBlockNumberPromise = silenceChromeUnCaughtPromise(ethereum.getBlockNumber(undefined))
		const rpcConnectionStatusPromise = silenceChromeUnCaughtPromise(getRpcConnectionStatus())
		const pendingTransactionAndSignableMessages = getConfirmationWindowRequests(await getPendingTransactionsAndMessages())
		if (pendingTransactionAndSignableMessages.length === 0) return false
		// Read only once there is a queue to show, so unavailable settings never fail an update that returns early.
		const settings = requireAvailableSettings(await getSettingsSnapshot())
		const visualizedSimulatorState = settings.simulationMode
			? await updatePopupVisualisationIfNeeded(ethereum, tokenPriceService, { onlyIfNotAlreadyUpdating })
			: createPassthroughCompleteVisualizedSimulation()
		const message: UpdateConfirmTransactionDialog = { method: 'popup_update_confirm_transaction_dialog', data: {
			currentBlockNumber: await currentBlockNumberPromise,
			rpcConnectionStatus: await rpcConnectionStatusPromise,
			visualizedSimulatorState,
		} }
		const messagePendingTransactions: UpdateConfirmTransactionDialogPendingTransactions = {
			method: 'popup_update_confirm_transaction_dialog_pending_transactions' as const,
			data: {
				pendingTransactionAndSignableMessages: pendingTransactionAndSignableMessages.map(toPopupPendingTransactionOrSignableMessage),
				currentBlockNumber: await currentBlockNumberPromise,
				rpcConnectionStatus: await rpcConnectionStatusPromise,
			}
		}
		await Promise.all([
			sendPopupMessageToOpenWindows(serialize(UpdateConfirmTransactionDialogPendingTransactions, messagePendingTransactions), 'confirmTransaction'),
			sendPopupMessageToOpenWindows(serialize(UpdateConfirmTransactionDialog, message), 'confirmTransaction')
		])
		return true
	} catch(error: unknown) {
		if (isExpectedInfrastructureError(error)) return false
		await reportUnexpectedError(error)
	}
	return false
}

const isSamePopupOrTab = (first: PopupOrTabId, second: PopupOrTabId) => first.type === second.type && first.id === second.id

// The confirmation window showing the queue is the first shown request's window that is still open, so a request that outlived its window never decides it.
async function getOpenConfirmationWindow(pendingTransactions: readonly PendingTransactionOrSignableMessage[]) {
	const checkedWindows: PopupOrTabId[] = []
	for (const pending of getConfirmationWindowRequests(pendingTransactions)) {
		if (checkedWindows.some((checked) => isSamePopupOrTab(checked, pending.popupOrTabId))) continue
		checkedWindows.push(pending.popupOrTabId)
		const openWindow = await getPopupOrTabById(pending.popupOrTabId)
		if (openWindow !== undefined) return openWindow
	}
	return undefined
}

export const isConfirmTransactionFocused = async () => {
	const popup = await getOpenConfirmationWindow(await getPendingTransactionsAndMessages())
	if (popup === undefined) return false
	if (popup.type === 'popup') return popup.window.focused
	return popup.tab.active
}

const getPendingTransactionOrMessageByidentifier = async (uniqueRequestIdentifier: UniqueRequestIdentifier) => {
	return (await getPendingTransactionsAndMessages()).find((tx) => doesUniqueRequestIdentifiersMatch(tx.uniqueRequestIdentifier, uniqueRequestIdentifier))
}

export const setGasLimitForTransaction = async (transactionIdentifier: bigint, gasLimit: bigint) => {
	const pendingTransaction = (await getPendingTransactionsAndMessages()).find((tx) => tx.type === 'Transaction' && tx.transactionIdentifier === transactionIdentifier)
	if (pendingTransaction === undefined) {
		const theTransactionIsAlreadyInStack = (await getInterceptorTransactionStack()).operations.some((transaction) => transaction.type === 'Transaction' && transaction.preSimulationTransaction.transactionIdentifier === transactionIdentifier)
		if (!theTransactionIsAlreadyInStack) return undefined
		await updateInterceptorTransactionStack((prevStack: InterceptorTransactionStack) => {
			return { operations: prevStack.operations.map((operation) => {
				if (operation.type !== 'Transaction') return operation
				if (operation.preSimulationTransaction.transactionIdentifier !== transactionIdentifier) return operation
				if (operation.preSimulationTransaction.originalRequestParameters.method !== 'eth_sendTransaction') return operation
				const originalParams = operation.preSimulationTransaction.originalRequestParameters
				const originalRequestParameters = modifyObject(originalParams, { params: [modifyObject(originalParams.params[0], { gas: gasLimit })] })
				return modifyObject(operation, { preSimulationTransaction: modifyObject(operation.preSimulationTransaction, { originalRequestParameters, signedTransaction: modifyObject(operation.preSimulationTransaction.signedTransaction, { gas: gasLimit })  }) })
			}) }
		})
		return
	}
	await updatePendingTransactionOrMessage(pendingTransaction.uniqueRequestIdentifier, async (transaction) => {
		if (transaction.originalRequestParameters.method === 'eth_sendTransaction') {
			const originalRequestParameters = modifyObject(transaction.originalRequestParameters, { params: [modifyObject(transaction.originalRequestParameters.params[0], { gas: gasLimit })] })
			return modifyObject(transaction, { originalRequestParameters: originalRequestParameters })
		}
		return transaction
	})
}

type ConfirmationServices = {
	readonly ethereum: EthereumClientService
	readonly tokenPriceService: TokenPriceService
}

// Publishes the requests confirmation windows show without RPC services, using the last block the connection status knows; returns whether any request is shown.
async function publishConfirmationQueueWithoutServices() {
	const shownRequests = getConfirmationWindowRequests(await getPendingTransactionsAndMessages())
	if (shownRequests.length === 0) return false
	const rpcConnectionStatus = await getRpcConnectionStatus()
	const messagePendingTransactions: UpdateConfirmTransactionDialogPendingTransactions = {
		method: 'popup_update_confirm_transaction_dialog_pending_transactions',
		data: {
			pendingTransactionAndSignableMessages: shownRequests.map(toPopupPendingTransactionOrSignableMessage),
			currentBlockNumber: rpcConnectionStatus?.latestBlock?.number ?? undefined,
			rpcConnectionStatus,
		},
	}
	await sendPopupMessageToOpenWindows(serialize(UpdateConfirmTransactionDialogPendingTransactions, messagePendingTransactions), 'confirmTransaction')
	return true
}

// Updates the confirmation window once a request has left the queue it shows, by being removed or by becoming deferred: the view of how the simulation stack changed (with RPC services), and the queue view, which focuses the website's tab once the queue is empty and closes the window once no shown request is in it. Without RPC services the queue is still published. The website's answer never waits for this view work, so a failure in it is reported instead of reaching the caller.
async function updateViewAfterPendingRequestRemoved(pending: PendingTransactionOrSignableMessage, services: ConfirmationServices | undefined, simulationStack: SimulationStackChange) {
	const removedRequestWindow = pending.popupOrTabId
	if (services !== undefined) await runConfirmationViewStep(async () => await showSimulationStackChange(services.ethereum, services.tokenPriceService, simulationStack))
	await runConfirmationViewStep(async () => {
		if (getConfirmationWindowRequests(await getPendingTransactionsAndMessages()).length === 0) await tryFocusingTabOrWindow({ type: 'tab', id: pending.uniqueRequestIdentifier.requestSocket.tabId })
	})
	await runConfirmationViewStep(async () => {
		const confirmationQueueIsShown = services === undefined ? await publishConfirmationQueueWithoutServices() : await updateConfirmTransactionView(services.ethereum, services.tokenPriceService)
		// The website may send its next request as soon as it has this answer. Arriving while the queue is empty, that request opens a window of its own, so this window is closed once no pending request is shown in it rather than only once the queue is empty.
		const windowShowsAPendingRequest = getConfirmationWindowRequests(await getPendingTransactionsAndMessages()).some((other) => isSamePopupOrTab(other.popupOrTabId, removedRequestWindow))
		if (!confirmationQueueIsShown || !windowShowsAPendingRequest) await closePopupOrTabById(removedRequestWindow)
	})
}

async function removeSettledPendingRequest(pending: PendingTransactionOrSignableMessage, services: ConfirmationServices | undefined) {
	await removePendingTransactionOrMessage(pending.uniqueRequestIdentifier)
	await updateViewAfterPendingRequestRemoved(pending, services, 'unchanged')
}

function formTerminalReply(pending: PendingTransactionOrSignableMessage, message: { type: 'result', error: { code: number, message: string } } | { type: 'result', result: unknown }): InterceptedRequestForward {
	const { uniqueRequestIdentifier } = pending
	if ('error' in message) return { ...pending.originalRequestParameters, ...message, uniqueRequestIdentifier }
	if (pending.originalRequestParameters.method === 'eth_sendRawTransaction' || pending.originalRequestParameters.method === 'eth_sendTransaction') {
		return { ...pending.originalRequestParameters, ...message, result: EthereumBytes32.parse(message.result), uniqueRequestIdentifier }
	}
	return { ...pending.originalRequestParameters, ...message, result: funtypes.String.parse(message.result), uniqueRequestIdentifier }
}

// A request already answered (its removal failed after its reply was queued) is not answered again: only its own reply still waiting in the queue is delivered.
async function deliverQueuedReply(websiteTabConnections: WebsiteTabConnections, reply: InterceptedRequestForward, queued: 'queued' | 'already-answered') {
	if (queued === 'queued') return await attemptQueuedTerminalReplyDelivery(websiteTabConnections, reply)
	return await deliverQueuedTerminalReplyOnce(websiteTabConnections, reply.uniqueRequestIdentifier)
}

// The reply is queued and the request is removed from the confirmation queue, so after a restart at most the reply's delivery is left. The reply is delivered before the view work, which cannot hold it back. A request holding a deferred Gnosis Safe signature is answered only by settling that signature (`settledSignerReply`); any other reply, such as a Reject made after the deferral, is refused and the request stays for its deferred settlement.
async function settlePendingTerminalReply(websiteTabConnections: WebsiteTabConnections, pending: PendingTransactionOrSignableMessage, message: { type: 'result', error: { code: number, message: string } } | { type: 'result', result: unknown }, services: ConfirmationServices | undefined, simulationStack: SimulationStackChange = 'unchanged', settledSignerReply?: string) {
	const terminalReply = formTerminalReply(pending, message)
	const queued = await queueTerminalReplyUnlessDeferred(terminalReply, settledSignerReply)
	if (queued === 'gone' || queued === 'deferred') return false
	try {
		await removePendingTransactionOrMessage(pending.uniqueRequestIdentifier)
	} catch (removalError: unknown) {
		// The answered request stays for its cleanup, which delivers the queued reply; this flow will not.
		if (queued === 'queued') releaseTerminalReplyReservation(terminalReply)
		throw removalError
	}
	try {
		return await deliverQueuedReply(websiteTabConnections, terminalReply, queued)
	} finally {
		// The request already left the confirmation queue, so its window is updated even when delivery throws. The delivery error still reaches the caller once the window is updated.
		await updateViewAfterPendingRequestRemoved(pending, services, simulationStack)
	}
}

function createDeferredSafeProposalReply(pending: PendingTransactionOrSignableMessage, safeTxHash: bigint) {
	if (pending.originalRequestParameters.method !== 'eth_sendTransaction' && pending.originalRequestParameters.method !== 'eth_sendRawTransaction') {
		throw new Error('A Gnosis Safe proposal must originate from a transaction request.')
	}
	const terminalReply = {
		...pending.originalRequestParameters,
		type: 'result' as const,
		result: EthereumBytes32.parse(EthereumBytes32.serialize(safeTxHash)),
		uniqueRequestIdentifier: pending.uniqueRequestIdentifier,
	}
	return terminalReply
}

function removeDeferredSafeSignerReply(pending: PendingTransactionOrSignableMessage): PendingTransactionOrSignableMessage {
	const { deferredSafeSignerReply: _deferredSafeSignerReply, ...remaining } = pending
	return remaining
}

// The network a Gnosis Safe proposal's signature is valid on: the chain of its EIP-712 domain (a proposal without one has no signing network and cannot be signed).
function getSafeProposalSigningChainId(pending: PendingTransactionOrSignableMessage) {
	const flow = getSafePendingFlow(pending)
	if (flow?.kind !== 'proposal') return undefined
	return flow.pending.safeTransaction.safeTx.domain.chainId ?? 0n
}

// The Gnosis Safe flows whose signer reply is a Safe signature settled through the signer-reply lifecycle below.
function getSafeSignerReplyFlow(pending: PendingTransactionOrSignableMessage) {
	if (pending.simulationMode) return undefined
	const flow = getSafePendingFlow(pending)
	return flow?.kind === 'proposal' || flow?.kind === 'messageCoSign' ? flow : undefined
}

// Requests whose signatures, Reject and cleanup only the Safe signer-reply lifecycle below may settle.
function isOwnedBySafeSignerReplyLifecycle(pending: PendingTransactionOrSignableMessage) {
	return getSafeSignerReplyFlow(pending) !== undefined || pending.deferredSafeSignerReply !== undefined
}

// A Safe signature that cannot be bound to the network it was signed for fails closed: it is not kept, and the request asks the user to sign again.
async function failSafeSignatureWithoutChain(uniqueRequestIdentifier: UniqueRequestIdentifier) {
	await updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (current) => modifyObject(removeDeferredSafeSignerReply(current), {
		approvalStatus: createSafeSignerErrorStatus('The Gnosis Safe signature could not be matched to its network while the RPC configuration is unavailable. Sign it again once it is restored.'),
	}))
}

// Gnosis Safe signer-reply lifecycle. Its single owner is advanceSafeSignerReply, which only runs inside runSafeSignerReplyLifecycle (one lock for every request) and re-reads the request before each transition. Every entry point goes through it: a signature from the signer or a popup's signerIncluded (resolveSafeSignature), popup close, no-response and Reject (resolvePendingRequestAsNoResponse), recovery at startup, on every services installation and on new blocks while work is outstanding (resolveDeferredSafeSignerReplies, advanceOutstandingSafeSignerReplies), and the retry of a failed step.
// 1) States of a pending request:
// - waiting-for-signer: no deferredSafeSignerReply and no websiteReplyQueued (as is every request outside these Safe flows).
// - claimed(signature, chain): deferredSafeSignerReply with its chainId; hidden from the confirmation window.
// - answered: websiteReplyQueued, written together with its queued website reply; it wins over a claim stored beside it.
// - settled: the request is gone: stored (Safe stack or proposal outbox) with its success reply, rejected, or answered and cleaned up.
// 2) Allowed transitions:
// - waiting-for-signer -> claimed: a string signature for a request with a recorded signing network (a request without one fails closed back to waiting-for-signer with an error).
// - waiting-for-signer -> answered -> settled: Reject or no-response queues the rejection, delivers it and removes the request.
// - claimed -> answered: services for its network validate and store the signature; its success reply is queued with the claim cleared in one write.
// - claimed -> waiting-for-signer: the signature fails validation (discarded with an error the user sees).
// - claimed proposal -> settled: without services for its network the success reply is queued and the proposal moved to the outbox in one write; the outbox stores it once services for its network are installed.
// - claimed co-signature -> claimed: without services for its network it waits for them.
// - answered -> settled: only the reply queued when it was answered is delivered (if still queued) and the request removed; nothing is validated, stored or queued again.
// - claims written by earlier builds: a proposal claim whose reply was already queued (terminalReplyQueued) -> settled through the outbox without a second reply (dropped visibly without a network), and a claim without its network -> waiting-for-signer with an error.
// 3) An unexpected failure keeps the stored state, so the request stays recoverable: a failed step is retried a bounded number of times (a claim with the signature it carries, any other step as an advance), then recovery advances every claimed or answered request, and an unsaved claim moves to a retryable signer error; spent retries are reported visibly.
type SafeSignerReplyState = 'gone' | 'waiting-for-signer' | 'claimed' | 'settled'

type SafeSignerReplyContext = {
	// The services captured with the entry point; they also update the confirmation window.
	readonly services: ConfirmationServices | undefined
	// Reads the services installed now, for a signature whose network the captured services are not for.
	readonly getInstalledServices: () => Promise<ConfirmationServices | undefined>
	readonly websiteTabConnections: WebsiteTabConnections
}

const safeSignerReplyLifecycleSemaphore = new Semaphore(1)
const safeSignerReplyRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
// Bounded: once these retries are spent, the step runs again only through recovery (startup, every services installation, and every new block while work is outstanding).
const SAFE_SIGNER_REPLY_RETRY_DELAYS_MS = [50, 250, 1000]

// A failed claim is retried as itself, so the retry still carries the signature it was claiming; any other failed step is retried as an advance of the request, which never rejects it (a failed rejection is retried by its own caller). Claims and advances of one request are retried independently of each other.
type SafeSignerReplyStep<Result> = {
	readonly name: 'claim' | 'advance'
	readonly run: () => Promise<Result>
	// Retried in place of `run`; defaults to it.
	readonly retry?: () => Promise<unknown>
	// The transition taken, as a lifecycle step of its own, once the bounded retries are spent.
	readonly afterRetriesSpent?: () => Promise<void>
}

// Transitions whose run after spent retries failed as well; the advance on every new block runs them again.
const pendingRetriesSpentTransitions = new Map<string, () => Promise<void>>()
// Spent retries are reported visibly once per request and step, not on every later advance that fails again.
const reportedSpentSafeSignerReplyRetries = new Set<string>()

async function runSafeSignerReplyLifecycle<Result>(uniqueRequestIdentifier: UniqueRequestIdentifier, step: SafeSignerReplyStep<Result>, retryAttempt = 0): Promise<Result> {
	try {
		return await safeSignerReplyLifecycleSemaphore.execute(step.run)
	} catch (error: unknown) {
		scheduleSafeSignerReplyRetry(uniqueRequestIdentifier, step, retryAttempt)
		throw error
	}
}

// The retry has no caller to report to, so its failures are reported here: as a local recovery while retries remain, and visibly once they are spent.
function scheduleSafeSignerReplyRetry<Result>(uniqueRequestIdentifier: UniqueRequestIdentifier, step: SafeSignerReplyStep<Result>, attempt: number) {
	const delay = SAFE_SIGNER_REPLY_RETRY_DELAYS_MS[attempt]
	const retryIdentifier = `${ getUniqueRequestIdentifierString(uniqueRequestIdentifier) } ${ step.name }`
	if (delay === undefined || safeSignerReplyRetryTimers.has(retryIdentifier)) return
	const retriedStep = { ...step, run: step.retry ?? step.run, retry: undefined }
	safeSignerReplyRetryTimers.set(retryIdentifier, setTimeout(() => {
		safeSignerReplyRetryTimers.delete(retryIdentifier)
		void (async () => {
			try {
				await runSafeSignerReplyLifecycle(uniqueRequestIdentifier, retriedStep, attempt + 1)
			} catch (error: unknown) {
				if (SAFE_SIGNER_REPLY_RETRY_DELAYS_MS[attempt + 1] !== undefined) {
					await reportLocalRecovery(error, { code: 'safe_signer_reply_retry_failed', message: 'Retrying a Gnosis Safe signature step after a transient failure.' })
					return
				}
				await finishSpentSafeSignerReplyRetries(error, uniqueRequestIdentifier, retryIdentifier, step)
			}
		})()
	}, delay))
}

async function finishSpentSafeSignerReplyRetries<Result>(error: unknown, uniqueRequestIdentifier: UniqueRequestIdentifier, retryIdentifier: string, step: SafeSignerReplyStep<Result>) {
	if (!reportedSpentSafeSignerReplyRetries.has(retryIdentifier)) {
		reportedSpentSafeSignerReplyRetries.add(retryIdentifier)
		await reportSafeSignerReplyRetriesExhausted(error, uniqueRequestIdentifier, step.name)
	}
	const transition = step.afterRetriesSpent
	if (transition === undefined) return
	try {
		await safeSignerReplyLifecycleSemaphore.execute(transition)
	} catch (transitionError: unknown) {
		pendingRetriesSpentTransitions.set(retryIdentifier, transition)
		await reportLocalRecovery(transitionError, { code: 'safe_signer_reply_spent_retries_transition_failed', message: 'Keeping a Gnosis Safe request\'s transition after spent retries for the next new block.' })
	}
}

// Shown even for connectivity errors: the user has signed and the website is still waiting. The message says whether the signature is kept for recovery, as far as storage can still tell.
async function reportSafeSignerReplyRetriesExhausted(error: unknown, uniqueRequestIdentifier: UniqueRequestIdentifier, stepName: SafeSignerReplyStep<unknown>['name']) {
	await reportUnexpectedError(error, {
		code: 'safe_signer_reply_retries_exhausted',
		displayMessage: await describeSpentSafeSignerReplyRetries(uniqueRequestIdentifier, stepName),
		suppressExpectedHandledErrors: false,
	})
}

async function describeSpentSafeSignerReplyRetries(uniqueRequestIdentifier: UniqueRequestIdentifier, stepName: SafeSignerReplyStep<unknown>['name']) {
	const unfinished = 'A Gnosis Safe confirmation could not be finished after repeated failures. It is finished once the RPC connection works again or the extension restarts.'
	let pending: PendingTransactionOrSignableMessage | undefined
	try {
		pending = await getPendingTransactionOrMessageByidentifier(uniqueRequestIdentifier)
	} catch (readError: unknown) {
		await reportLocalRecovery(readError, { code: 'safe_signer_reply_state_unreadable', message: 'Describing spent Gnosis Safe signature retries without the stored request.' })
		return unfinished
	}
	if (pending?.deferredSafeSignerReply !== undefined) return 'A Gnosis Safe signature could not be settled after repeated failures. It is kept and settled once the RPC connection works again.'
	if (stepName === 'claim' && pending !== undefined && pending.websiteReplyQueued !== true) return 'A Gnosis Safe signature could not be saved after repeated failures. Sign the request again.'
	return unfinished
}

// Claim retries spent with the signature never saved: waiting-for-signer moves to a retryable signer error, so signing is available again and the window shows it. A claim or answer written meanwhile, or any other approval state, is kept.
async function failUnsavedSafeSignature(uniqueRequestIdentifier: UniqueRequestIdentifier, context: SafeSignerReplyContext) {
	let failed = false
	await updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (current) => {
		if (current.deferredSafeSignerReply !== undefined || current.websiteReplyQueued === true || current.approvalStatus.status !== 'WaitingForSigner') return current
		failed = true
		return modifyObject(current, { approvalStatus: createSafeSignerErrorStatus('The Gnosis Safe signature could not be saved after repeated failures. Sign the request again.') })
	})
	if (!failed) return
	const services = context.services
	await runConfirmationViewStep(async () => services === undefined ? await publishConfirmationQueueWithoutServices() : await updateConfirmTransactionView(services.ethereum, services.tokenPriceService))
}

// A signature is bound to the network it was signed for: it is settled only with services for that network, the captured ones or else the ones installed now.
async function getServicesForChain(context: SafeSignerReplyContext, chainId: bigint) {
	if (context.services !== undefined && context.services.ethereum.getChainId() === chainId) return context.services
	const installedServices = await context.getInstalledServices()
	if (installedServices === undefined || installedServices.ethereum.getChainId() !== chainId) return undefined
	return installedServices
}

// Takes the one transition the request's stored state allows; must run inside runSafeSignerReplyLifecycle.
async function advanceSafeSignerReply(uniqueRequestIdentifier: UniqueRequestIdentifier, context: SafeSignerReplyContext): Promise<SafeSignerReplyState> {
	const pending = await getPendingTransactionOrMessageByidentifier(uniqueRequestIdentifier)
	if (pending === undefined) return 'gone'
	if (pending.websiteReplyQueued === true) {
		await deliverQueuedTerminalReplyOnce(context.websiteTabConnections, uniqueRequestIdentifier)
		await removeSettledPendingRequest(pending, context.services)
		return 'settled'
	}
	const claim = pending.deferredSafeSignerReply
	if (claim === undefined) return 'waiting-for-signer'
	const flow = getSafePendingFlow(pending)
	if (flow?.kind === 'proposal' && claim.terminalReplyQueued === true) {
		await settleAcknowledgedSafeProposal(pending, flow.pending.safeTransaction.safeTxHash, claim.signerReply, claim.chainId, context)
		return 'settled'
	}
	if (claim.chainId === undefined) {
		await failSafeSignatureWithoutChain(uniqueRequestIdentifier)
		return 'waiting-for-signer'
	}
	const services = await getServicesForChain(context, claim.chainId)
	if (services !== undefined) {
		await settleConfirmation(services.ethereum, services.tokenPriceService, context.websiteTabConnections, {
			method: 'popup_confirmDialog',
			data: { uniqueRequestIdentifier, action: 'signerIncluded', signerReply: claim.signerReply },
		})
		const validated = await getPendingTransactionOrMessageByidentifier(uniqueRequestIdentifier)
		if (validated === undefined) return 'settled'
		if (validated.websiteReplyQueued === true) return await advanceSafeSignerReply(uniqueRequestIdentifier, context)
		return validated.deferredSafeSignerReply === undefined ? 'waiting-for-signer' : 'claimed'
	}
	if (flow?.kind === 'proposal') {
		await moveSignedSafeProposalToOutbox(pending, flow.pending.safeTransaction.safeTxHash, { signerReply: claim.signerReply, chainId: claim.chainId }, context.websiteTabConnections, context.services, false)
		return 'settled'
	}
	return 'claimed'
}

// waiting-for-signer -> claimed, advanced at once in the same lifecycle step, so no other entry point sees the claim before its first transition. A claim already stored for the request is advanced rather than replaced, so a retried claim never overwrites a newer one. Returns whether the request was settled (undefined when it was already gone).
async function claimSafeSignature(uniqueRequestIdentifier: UniqueRequestIdentifier, signerReply: string, context: SafeSignerReplyContext) {
	const claim = await runSafeSignerReplyLifecycle(uniqueRequestIdentifier, { name: 'claim', afterRetriesSpent: async () => await failUnsavedSafeSignature(uniqueRequestIdentifier, context), run: async () => {
		const pending = await getPendingTransactionOrMessageByidentifier(uniqueRequestIdentifier)
		if (pending === undefined) return { pending, state: 'gone' as const }
		if (pending.deferredSafeSignerReply === undefined && pending.websiteReplyQueued !== true) {
			const chainId = pending.signerRequestChainId
			// Without the network the signer signed for, the signature could be validated or stored on another network, so it is not kept.
			if (chainId === undefined) {
				await failSafeSignatureWithoutChain(uniqueRequestIdentifier)
				return { pending, state: 'waiting-for-signer' as const }
			}
			// An answered request (its window close or Reject won) refuses the claim and keeps its own answer, which this step then finishes.
			if (await deferSignatureUnlessAnswered(uniqueRequestIdentifier, { signerReply, chainId }) === 'gone') return { pending, state: 'gone' as const }
		}
		return { pending, state: await advanceSafeSignerReply(uniqueRequestIdentifier, context) }
	} })
	// The waiting co-signature left the queue its window shows, so the window moves on to the next request or closes.
	if (claim.state === 'claimed' && claim.pending !== undefined) await updateViewAfterPendingRequestRemoved(claim.pending, context.services, 'unchanged')
	if (claim.state === 'gone') return undefined
	return claim.state === 'settled'
}

// Every Safe signature, from the signer reply or a popup's signerIncluded, enters the lifecycle here.
async function resolveSafeSignature(uniqueRequestIdentifier: UniqueRequestIdentifier, signerReply: unknown, context: SafeSignerReplyContext) {
	if (typeof signerReply !== 'string') {
		await updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (current) => modifyObject(current, {
			approvalStatus: createSafeSignerErrorStatus('The signer returned a non-string Gnosis Safe signature.'),
		}))
		return false
	}
	return await claimSafeSignature(uniqueRequestIdentifier, signerReply, context)
}

// `services` were captured when the reply arrived; `getInstalledServices` reads the services installed now.
export async function resolvePendingSignerReply(services: ConfirmationServices | undefined, getInstalledServices: () => Promise<ConfirmationServices | undefined>, websiteTabConnections: WebsiteTabConnections, uniqueRequestIdentifier: UniqueRequestIdentifier, params: SignerReply['params'][0]) {
	if (!params.success) {
		const approvalStatus = params.error.code === METAMASK_ERROR_USER_REJECTED_REQUEST
			? { status: 'WaitingForUser' as const }
			: { status: 'SignerError' as const, ...params.error }
		await updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (pending) => modifyObject(pending, { approvalStatus }))
		if (services !== undefined) await updateConfirmTransactionView(services.ethereum, services.tokenPriceService)
		return
	}
	const pending = await getPendingTransactionOrMessageByidentifier(uniqueRequestIdentifier)
	if (pending === undefined) return
	if (isOwnedBySafeSignerReplyLifecycle(pending)) return await resolveSafeSignature(uniqueRequestIdentifier, params.reply, { services, getInstalledServices, websiteTabConnections })
	if (services !== undefined) {
		return await resolvePendingTransactionOrMessage(services.ethereum, services.tokenPriceService, websiteTabConnections, {
			method: 'popup_confirmDialog',
			data: { uniqueRequestIdentifier, action: 'signerIncluded', signerReply: params.reply },
		})
	}
	if (pending.simulationMode) {
		await updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (current) => modifyObject(current, { approvalStatus: { status: 'SignerError', ...RPC_CONFIGURATION_UNAVAILABLE_ERROR } }))
		return
	}
	return await settlePendingTerminalReply(websiteTabConnections, pending, { type: 'result', result: params.reply }, undefined)
}

// Recovery of the lifecycle, run at startup, whenever services are installed for a network and on new blocks while work is outstanding (advanceOutstandingSafeSignerReplies): every claimed or answered request is advanced (a claim settled with these services when they are for its network, an answered request finished whatever its window), then outbox proposals for that network are added to the Safe stack.
export async function resolveDeferredSafeSignerReplies(services: ConfirmationServices, websiteTabConnections: WebsiteTabConnections) {
	const context: SafeSignerReplyContext = { services, getInstalledServices: async () => services, websiteTabConnections }
	const outstandingRequests = (await getPendingTransactionsAndMessages()).filter((pending) => pending.deferredSafeSignerReply !== undefined || pending.websiteReplyQueued === true)
	const requestFailures = await runEachIndependently(outstandingRequests, async (pending) => await runSafeSignerReplyLifecycle(pending.uniqueRequestIdentifier, { name: 'advance', run: async () => await advanceSafeSignerReply(pending.uniqueRequestIdentifier, context) }))
	const outboxFailures = await storeSafeProposalsFromOutbox(services)
	await surfaceIndependentFailures([...requestFailures, ...outboxFailures])
}

// Each item of a recovery pass is its own lifecycle step: one failing item (keeping its own retry state) never holds back the items after it.
async function runEachIndependently<Item>(items: readonly Item[], run: (item: Item) => Promise<unknown>) {
	const failures: unknown[] = []
	for (const item of items) {
		try {
			await run(item)
		} catch (error: unknown) {
			failures.push(error)
		}
	}
	return failures
}

// The pass as a whole still fails, with its first failure, once every item ran; the other failures are reported so none goes unseen.
async function surfaceIndependentFailures(failures: readonly unknown[]) {
	if (failures.length === 0) return
	for (const failure of failures.slice(1)) await reportLocalRecovery(failure, { code: 'pending_confirmation_recovery_item_failed', message: 'One item failed during recovery; the other items were still recovered.' })
	throw failures[0]
}

// The terminal-state recovery run at startup and whenever services are installed. Its phases are independent: a Safe signer-reply item that keeps failing never keeps a request whose window disappeared unanswered, nor its replies to closed tabs queued. The recovery still fails, with its first failure, once every phase ran.
export async function recoverPendingConfirmationState(services: ConfirmationServices, websiteTabConnections: WebsiteTabConnections) {
	const phases = [
		async () => await resolveDeferredSafeSignerReplies(services, websiteTabConnections),
		async () => await resolvePendingRequestsForMissingConfirmationWindows(services.ethereum, services.tokenPriceService, websiteTabConnections),
		prunePendingTerminalRepliesForMissingTabs,
	]
	await surfaceIndependentFailures(await runEachIndependently(phases, async (phase) => await phase()))
}

// At most one advance on new blocks runs at a time; a block arriving meanwhile skips it.
const safeSignerReplyAdvancesOnNewBlock = new Set<Promise<void>>()

// Runs on every new block with the installed services: lifecycle work left after its bounded retries (a claim, an answered request, an outbox proposal for these services' network, or a transition after spent retries) is advanced even when the RPC connection status never went down, for example when only signature validation failed. Nothing runs when nothing is outstanding.
export async function advanceOutstandingSafeSignerReplies(services: ConfirmationServices, websiteTabConnections: WebsiteTabConnections) {
	if (safeSignerReplyAdvancesOnNewBlock.size > 0) return
	const advance = (async () => {
		const failures = await runEachIndependently([...pendingRetriesSpentTransitions], async ([retryIdentifier, transition]) => {
			await safeSignerReplyLifecycleSemaphore.execute(transition)
			pendingRetriesSpentTransitions.delete(retryIdentifier)
		})
		if (await hasOutstandingSafeSignerReplyWork(services)) {
			try {
				await resolveDeferredSafeSignerReplies(services, websiteTabConnections)
			} catch (passFailure: unknown) {
				failures.push(passFailure)
			}
		}
		await surfaceIndependentFailures(failures)
	})()
	safeSignerReplyAdvancesOnNewBlock.add(advance)
	try {
		await advance
	} finally {
		safeSignerReplyAdvancesOnNewBlock.delete(advance)
	}
}

async function hasOutstandingSafeSignerReplyWork(services: ConfirmationServices) {
	if ((await getPendingTransactionsAndMessages()).some((pending) => pending.deferredSafeSignerReply !== undefined || pending.websiteReplyQueued === true)) return true
	return (await getPendingSafeProposalStores()).some((entry) => entry.chainId === services.ethereum.getChainId())
}

// Adds every outbox proposal signed for the installed services' network to its Safe stack once, each entry as its own lifecycle step; proposals for other networks stay. Proposals of one Safe may hold consecutive nonces, each stored on top of the one before, so they are stored in nonce order and a transient failure stops only their Safe's group: its later proposals stay untouched for the next pass instead of failing the nonce check, and other Safes go on. The website already has its reply, so a proposal that cannot be stored is dropped with a visible failure and nothing more is sent to the website.
async function storeSafeProposalsFromOutbox(services: ConfirmationServices) {
	const entriesForNetwork = (await getPendingSafeProposalStores()).filter((entry) => entry.chainId === services.ethereum.getChainId())
	return await runEachIndependently(groupOutboxProposalsBySafeInNonceOrder(entriesForNetwork), async (safeGroup) => {
		for (const entry of safeGroup) await safeSignerReplyLifecycleSemaphore.execute(async () => await storeSafeProposalFromOutbox(services, entry))
	})
}

function groupOutboxProposalsBySafeInNonceOrder(entries: readonly PendingSafeProposalStore[]) {
	const groups = new Map<string, { readonly nonce: bigint, readonly entry: PendingSafeProposalStore }[]>()
	for (const entry of entries) {
		const flow = getSafePendingFlow(entry.proposal)
		const safeTransaction = flow?.kind === 'proposal' ? flow.pending.safeTransaction : undefined
		const groupKey = safeTransaction === undefined ? `request ${ getUniqueRequestIdentifierString(entry.proposal.uniqueRequestIdentifier) }` : `${ entry.chainId.toString() } ${ safeTransaction.safeAddress.toString() }`
		groups.set(groupKey, [...groups.get(groupKey) ?? [], { nonce: safeTransaction?.safeTx.message.nonce ?? 0n, entry }])
	}
	return [...groups.values()].map((group) => [...group].sort((first, second) => first.nonce < second.nonce ? -1 : first.nonce > second.nonce ? 1 : 0).map(({ entry }) => entry))
}

async function storeSafeProposalFromOutbox(services: ConfirmationServices, entry: PendingSafeProposalStore) {
	// Read again inside the step: a concurrent pass may already have stored it.
	if (!(await getPendingSafeProposalStores()).some((current) => doesUniqueRequestIdentifiersMatch(current.proposal.uniqueRequestIdentifier, entry.proposal.uniqueRequestIdentifier))) return
	const stored = await storeOutboxProposal(services, entry)
	await removePendingSafeProposalStore(entry.proposal.uniqueRequestIdentifier)
	if (stored.status === 'failed-permanently') {
		await reportSafeProposalNotStored(stored.reason)
		return
	}
	if (stored.status === 'success') {
		await runConfirmationViewStep(async () => await showSimulationStackChange(services.ethereum, services.tokenPriceService, stored.simulationStack))
		return
	}
	await reportSafeProposalNotStored(stored.status === 'error' ? stored.approvalStatus.message : 'It is no longer a Gnosis Safe proposal.')
}

// A Safe whose contract answers with a revert or with data that does not decode fails the same way on every attempt (for example after its implementation changed while the proposal waited), so its entry is dropped like one that fails validation. Transport failures and other errors may pass, so they are thrown and the entry stays for the next pass.
const isPermanentSafeProposalStoreFailure = (error: unknown) => isAbiDataDecodeError(error) || error instanceof JsonRpcResponseError && (error.code === 3 || /revert/iu.test(error.message))

async function storeOutboxProposal(services: ConfirmationServices, entry: PendingSafeProposalStore) {
	try {
		return await resolveSafeSignerReply(services.ethereum, entry.proposal, entry.signerReply)
	} catch (error: unknown) {
		if (!isPermanentSafeProposalStoreFailure(error)) throw error
		return { status: 'failed-permanently' as const, reason: `Its Gnosis Safe could not be read: ${ getErrorMessage(error) ?? 'the contract call failed.' }` }
	}
}

// The failure is a validation result rather than a thrown error, so its reason is the reported value (as for errors reported from popup windows) and the popup shows it.
async function reportSafeProposalNotStored(reason: string) {
	await reportUnexpectedError(reason, {
		source: 'safe_proposal_outbox',
		code: 'safe_proposal_not_stored',
		displayMessage: `A signed Gnosis Safe proposal could not be added to the Safe stack, and the website already received its proposal hash. ${ reason }`,
		suppressExpectedHandledErrors: false,
	})
}

// Settles a pending Safe proposal whose signer already returned its signature: the website is told the proposal hash unless it already was, the request is settled like any other completed request, and the signed proposal waits in the outbox for services for its network.
async function moveSignedSafeProposalToOutbox(
	pending: PendingTransactionOrSignableMessage,
	safeTxHash: bigint,
	signedProposal: { readonly signerReply: string, readonly chainId: bigint },
	websiteTabConnections: WebsiteTabConnections,
	services: ConfirmationServices | undefined,
	websiteHasItsReply: boolean,
) {
	const createStore = (proposal: PendingTransactionOrSignableMessage) => ({ ...signedProposal, proposal: removeDeferredSafeSignerReply(proposal) })
	try {
		if (websiteHasItsReply) {
			await movePendingSafeProposalToOutbox(pending.uniqueRequestIdentifier, createStore, getPendingTerminalReplies)
			return true
		}
		const terminalReply = createDeferredSafeProposalReply(pending, safeTxHash)
		if (await queueSafeProposalReplyAndMoveToOutbox(pending.uniqueRequestIdentifier, createStore, terminalReply) !== 'moved') return false
		return await attemptQueuedTerminalReplyDelivery(websiteTabConnections, terminalReply)
	} finally {
		await updateViewAfterPendingRequestRemoved(pending, services, 'unchanged')
	}
}

// Earlier builds kept a Safe proposal pending, claimed, after its website reply was queued (`terminalReplyQueued`). It leaves the pending queue for the outbox without a second reply, or, when its signing network was not recorded, is dropped with a visible failure (re-signing through the completed request is impossible).
async function settleAcknowledgedSafeProposal(pending: PendingTransactionOrSignableMessage, safeTxHash: bigint, signerReply: string, chainId: bigint | undefined, context: SafeSignerReplyContext) {
	if (chainId !== undefined) {
		await moveSignedSafeProposalToOutbox(pending, safeTxHash, { signerReply, chainId }, context.websiteTabConnections, context.services, true)
		return
	}
	await removeSettledPendingRequest(pending, context.services)
	await reportSafeProposalNotStored('Its network was not recorded.')
}

// A review refresh is formed from the request as read when the confirmation began, so it is written only while the stored request still awaits the user's review (not waiting for its signer, claimed or answered), keeping the stored signing network; returns whether it was written.
async function writeReviewRefresh(refreshed: PendingTransactionOrSignableMessage) {
	let written = false
	await updatePendingTransactionOrMessage(refreshed.uniqueRequestIdentifier, async (current) => {
		if (current.approvalStatus.status === 'WaitingForSigner' || current.deferredSafeSignerReply !== undefined || current.websiteReplyQueued === true) return current
		written = true
		return current.signerRequestChainId === undefined ? refreshed : modifyObject(refreshed, { signerRequestChainId: current.signerRequestChainId })
	})
	return written
}

// The entry point of every confirmation decision. No-response, and the Reject and signature (signerIncluded, from the signer or a popup) of a request the Safe signer-reply lifecycle owns, are steps of that lifecycle; everything else is settled directly.
export async function resolvePendingTransactionOrMessage(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, websiteTabConnections: WebsiteTabConnections, confirmation: TransactionConfirmation, refreshedSafeSignerSelection?: RefreshedSafeSignerSelection) {
	const services = { ethereum, tokenPriceService }
	if (confirmation.data.action === 'noResponse') return await resolvePendingRequestAsNoResponse(confirmation.data.uniqueRequestIdentifier, services, websiteTabConnections)
	const pending = await getPendingTransactionOrMessageByidentifier(confirmation.data.uniqueRequestIdentifier)
	if (pending === undefined) return // no need to resolve as it doesn't exist anymore
	// Reject follows the popup-close rules, so a signature the signer already returned is settled as signed rather than rejected, and an answered request only finishes its own answer.
	if (confirmation.data.action === 'reject' && (isOwnedBySafeSignerReplyLifecycle(pending) || pending.websiteReplyQueued === true)) {
		return await resolvePendingRequestAsNoResponse(confirmation.data.uniqueRequestIdentifier, services, websiteTabConnections)
	}
	if (confirmation.data.action === 'signerIncluded' && isOwnedBySafeSignerReplyLifecycle(pending)) {
		return await resolveSafeSignature(confirmation.data.uniqueRequestIdentifier, confirmation.data.signerReply, { services, getInstalledServices: async () => services, websiteTabConnections })
	}
	return await settleConfirmation(ethereum, tokenPriceService, websiteTabConnections, confirmation, refreshedSafeSignerSelection)
}

// Reject and no-response need no RPC services: both are the no-response step of the lifecycle owner, which rejects a request waiting for its signer and keeps a returned Safe signature for services for its network.
export const isServiceIndependentConfirmation = (confirmation: TransactionConfirmation) => confirmation.data.action === 'reject' || confirmation.data.action === 'noResponse'

export async function resolveConfirmationWithoutServices(websiteTabConnections: WebsiteTabConnections, confirmation: TransactionConfirmation) {
	if (!isServiceIndependentConfirmation(confirmation)) throw new Error('Only Reject and no-response are settled without RPC services.')
	return await resolvePendingRequestAsNoResponse(confirmation.data.uniqueRequestIdentifier, undefined, websiteTabConnections)
}

// Settles a confirmation decision directly. Lock-free: for a request the Safe signer-reply lifecycle owns it is only called by that lifecycle's owner (advanceSafeSignerReply).
async function settleConfirmation(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, websiteTabConnections: WebsiteTabConnections, confirmation: TransactionConfirmation, refreshedSafeSignerSelection?: RefreshedSafeSignerSelection) {
	let pendingTransactionOrMessage = await getPendingTransactionOrMessageByidentifier(confirmation.data.uniqueRequestIdentifier)
	if (pendingTransactionOrMessage === undefined) return
	if (
		confirmation.data.action === 'accept'
		&& refreshedSafeSignerSelection?.selectedSigner !== undefined
		&& refreshedSafeSignerSelection.verificationError === undefined
	) {
		const directSafeExecution = getSafePendingFlow(pendingTransactionOrMessage)?.kind === 'directExecution'
		const refresh = await refreshAndPersistSafeSignerSelection(
			ethereum,
			pendingTransactionOrMessage,
			refreshedSafeSignerSelection.selectedSigner,
			async (refreshedPending) => await refreshDirectSafeExecutionSimulation(ethereum, tokenPriceService, refreshedPending),
		)
		const refreshResult = refresh.refreshResult
		if (refresh.refreshRequired && refreshResult.status !== 'unchanged' && !refresh.persisted) {
			await updateConfirmTransactionView(ethereum, tokenPriceService)
			return false
		}
		if (refresh.refreshRequired && (refreshResult.status === 'blocked' || directSafeExecution && refreshResult.status === 'refreshed')) {
			await updateConfirmTransactionView(ethereum, tokenPriceService)
			return false
		}
		if (refresh.persistedPending !== undefined) pendingTransactionOrMessage = refresh.persistedPending
	}
	const safeResolution = await resolveSafeConfirmation(
		ethereum,
		pendingTransactionOrMessage,
		confirmation.data.action,
		refreshedSafeSignerSelection,
	)
	if (safeResolution.status === 'blocked') {
		await updatePendingTransactionOrMessage(confirmation.data.uniqueRequestIdentifier, async (pending) => modifyObject(pending, {
			approvalStatus: safeResolution.approvalStatus,
		}))
		await updateConfirmTransactionView(ethereum, tokenPriceService)
		return false
	}
	if (safeResolution.status === 'refreshed') {
		pendingTransactionOrMessage = safeResolution.pending
		await writeReviewRefresh(pendingTransactionOrMessage)
		await updateConfirmTransactionView(ethereum, tokenPriceService)
		return false
	}
	pendingTransactionOrMessage = safeResolution.pending
	if (safeResolution.pendingChanged && !await writeReviewRefresh(pendingTransactionOrMessage)) {
		await updateConfirmTransactionView(ethereum, tokenPriceService)
		return false
	}
	const signerFacingRequest: SendTransactionParams | SendRawTransactionParams | SignMessageParams = safeResolution.signerFacingRequest
		?? pendingTransactionOrMessage.originalRequestParameters
	const removePendingRequestAndUpdateView = async () => {
		await removeSettledPendingRequest(pendingTransactionOrMessage, { ethereum, tokenPriceService })
	}
	// Settling the signer's signature may answer a request holding that signature deferred; any other reply is refused while a signature is deferred.
	const settledSignerReply = confirmation.data.action === 'signerIncluded' && typeof confirmation.data.signerReply === 'string' ? confirmation.data.signerReply : undefined
	const reply = async (message: { type: 'forwardToSigner' } | { type: 'result', error: { code: number, message: string } } | { type: 'result', result: unknown }, simulationStack: SimulationStackChange = 'unchanged') => {
		if (message.type === 'result') return await settlePendingTerminalReply(websiteTabConnections, pendingTransactionOrMessage, message, { ethereum, tokenPriceService }, simulationStack, settledSignerReply)
		await removePendingRequestAndUpdateView()
		return await replyToInterceptedRequestAfterManifestV2Reconnect(websiteTabConnections, { ...pendingTransactionOrMessage.originalRequestParameters, ...message, uniqueRequestIdentifier: confirmation.data.uniqueRequestIdentifier })
	}
	if (confirmation.data.action === 'addToSafeStack') {
		if (pendingTransactionOrMessage.approvalStatus.status === 'WaitingForSigner') return false
		const safeReply = await persistUnsignedSafeTransaction(ethereum, pendingTransactionOrMessage)
		if (safeReply.status === 'error') {
			await updatePendingTransactionOrMessage(confirmation.data.uniqueRequestIdentifier, async (pending) => modifyObject(pending, {
				approvalStatus: safeReply.approvalStatus,
			}))
			await updateConfirmTransactionView(ethereum, tokenPriceService)
			return false
		}
		if (safeReply.status === 'success') return reply({ type: 'result', result: safeReply.result }, safeReply.simulationStack)
		return false
	}
	if (
		confirmation.data.action === 'accept'
		&& pendingTransactionOrMessage.transactionOrMessageCreationStatus !== 'Simulated'
	) return false
	if (confirmation.data.action === 'accept' && pendingTransactionOrMessage.simulationMode === false) {
		// A Gnosis Safe proposal's signature is bound to its EIP-712 domain's network, which is recorded as its signing network; services on another network cannot forward, validate or store it, so the proposal must be reviewed again there.
		const proposalChainId = getSafeProposalSigningChainId(pendingTransactionOrMessage)
		if (proposalChainId !== undefined && proposalChainId !== ethereum.getChainId()) {
			await updatePendingTransactionOrMessage(confirmation.data.uniqueRequestIdentifier, async (transaction) => modifyObject(transaction, {
				approvalStatus: createSafeSignerErrorStatus('This Gnosis Safe proposal was prepared for another network than the one the Interceptor is connected to. Reject it and propose it again from the website on the current network.'),
			}))
			await updateConfirmTransactionView(ethereum, tokenPriceService)
			return false
		}
		const signerRequestChainId = proposalChainId ?? ethereum.getChainId()
		await updatePendingTransactionOrMessage(confirmation.data.uniqueRequestIdentifier, async (transaction) => modifyObject(transaction, { approvalStatus: { status: 'WaitingForSigner' }, signerRequestChainId }))
		await updateConfirmTransactionView(ethereum, tokenPriceService)
		const requestWasForwarded = await replyToInterceptedRequestAfterManifestV2Reconnect(websiteTabConnections, { ...signerFacingRequest, type: 'forwardToSigner', uniqueRequestIdentifier: confirmation.data.uniqueRequestIdentifier })
		if (requestWasForwarded) return true
		await updatePendingTransactionOrMessage(confirmation.data.uniqueRequestIdentifier, async (transaction) => modifyObject(transaction, {
			approvalStatus: {
				status: 'SignerError',
				code: METAMASK_ERROR_BLANKET_ERROR,
				message: 'The website connection was interrupted before the request reached your wallet. Reload the website and try again.',
			}
		}))
		await updateConfirmTransactionView(ethereum, tokenPriceService)
		return false
	}
	if (pendingTransactionOrMessage === undefined || pendingTransactionOrMessage.transactionOrMessageCreationStatus !== 'Simulated') return reply(formRejectMessage(METAMASK_ERROR_BLANKET_ERROR, 'The Interceptor failed to process the transaction'))
	if (confirmation.data.action === 'reject') return reply(formRejectMessage(METAMASK_ERROR_USER_REJECTED_REQUEST, 'User denied transaction signature'))
	if (!pendingTransactionOrMessage.simulationMode) {
		if (confirmation.data.action === 'signerIncluded') {
			const safeReply = await resolveSafeSignerReply(ethereum, pendingTransactionOrMessage, confirmation.data.signerReply)
			if (safeReply.status === 'error') {
				await updatePendingTransactionOrMessage(confirmation.data.uniqueRequestIdentifier, async (pending) => modifyObject(removeDeferredSafeSignerReply(pending), { approvalStatus: safeReply.approvalStatus }))
				await updateConfirmTransactionView(ethereum, tokenPriceService)
				return false
			}
			if (safeReply.status === 'success') return reply({ type: 'result', result: safeReply.result }, safeReply.simulationStack)
			return reply({ type: 'result', result: confirmation.data.signerReply })
		}
		await removePendingRequestAndUpdateView()
		return await replyToInterceptedRequestAfterManifestV2Reconnect(websiteTabConnections, { ...signerFacingRequest, type: 'forwardToSigner', uniqueRequestIdentifier: confirmation.data.uniqueRequestIdentifier })
	}
	if (confirmation.data.action === 'signerIncluded') throw new Error('Signer included transaction that was in simulation')

	switch (pendingTransactionOrMessage.type) {
		case 'SignableMessage': {
			await updateInterceptorTransactionStack((prevStack: InterceptorTransactionStack) => ({ operations: [
				...prevStack.operations,
				{ type: 'Message' as const, signedMessageTransaction: pendingTransactionOrMessage.signedMessageTransaction }
			] }))
			return reply({ type: 'result', result: (await simulatePersonalSign(pendingTransactionOrMessage.originalRequestParameters, pendingTransactionOrMessage.signedMessageTransaction.fakeSignedFor)).signature }, 'changed')
		}
		case 'Transaction': {
			const signedTransaction = getSignedTransactionForSimulation(pendingTransactionOrMessage.transactionToSimulate)
			const transaction = { ...pendingTransactionOrMessage.transactionToSimulate, signedTransaction }
			await updateInterceptorTransactionStack((prevStack: InterceptorTransactionStack) => ({ operations: [
				...prevStack.operations,
				{ type: 'Transaction' as const, preSimulationTransaction: transaction}
			] }))
			markPerformance(POPUP_PERFORMANCE_MARKS.backgroundTransactionStackAppended)
			return reply({ type: 'result', result: EthereumBytes32.serialize(signedTransaction.hash) }, 'changed')
		}
		default: assertNever(pendingTransactionOrMessage)
	}
}

export const onCloseWindowOrTab = async (popupOrTabs: PopupOrTabId, ethereum: EthereumClientService | undefined, tokenPriceService: TokenPriceService | undefined, websiteTabConnections: WebsiteTabConnections) => { // check if user has closed the window on their own, if so, reject all signatures
	// Exactly the requests shown in the closed window are answered; requests that live in another window are untouched.
	const closedWindowRequests = (await getPendingTransactionsAndMessages()).filter((pending) => isSamePopupOrTab(pending.popupOrTabId, popupOrTabs))
	if (closedWindowRequests.length === 0) return
	const services = ethereum === undefined || tokenPriceService === undefined ? undefined : { ethereum, tokenPriceService }
	await resolveAllPendingTransactionsAndMessageAsNoResponse(closedWindowRequests, services, websiteTabConnections)
}

export async function resolvePendingRequestsForMissingConfirmationWindows(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, websiteTabConnections: WebsiteTabConnections) {
	const pendingTransactions = await getPendingTransactionsAndMessages()
	const missingConfirmationWindows = new Map<string, boolean>()
	const orphanedTransactions: PendingTransactionOrSignableMessage[] = []
	for (const transaction of pendingTransactions) {
		const windowIdentifier = `${ transaction.popupOrTabId.type }:${ transaction.popupOrTabId.id }`
		let confirmationWindowIsMissing = missingConfirmationWindows.get(windowIdentifier)
		if (confirmationWindowIsMissing === undefined) {
			confirmationWindowIsMissing = await getPopupOrTabById(transaction.popupOrTabId) === undefined
			missingConfirmationWindows.set(windowIdentifier, confirmationWindowIsMissing)
		}
		if (confirmationWindowIsMissing) orphanedTransactions.push(transaction)
	}
	await resolveAllPendingTransactionsAndMessageAsNoResponse(orphanedTransactions, { ethereum, tokenPriceService }, websiteTabConnections)
}

const resolveAllPendingTransactionsAndMessageAsNoResponse = async (transactions: readonly PendingTransactionOrSignableMessage[], services: ConfirmationServices | undefined, websiteTabConnections: WebsiteTabConnections) => {
	for (const transaction of transactions) {
		try {
			await resolvePendingRequestAsNoResponse(transaction.uniqueRequestIdentifier, services, websiteTabConnections)
		} catch(e) {
			await reportLocalRecovery(e, { code: 'pending_request_no_response_resolution_failed', message: 'Failed to resolve a pending request as no-response after a popup closed.' })
			schedulePendingNoResponseRetry(transaction, services, websiteTabConnections)
		}
	}
}

// Single owner of the no-response outcome (popup report, Reject of a Safe signer-reply request, or a confirmation window that disappeared), run as one step of the Safe signer-reply lifecycle: the request is first advanced, so a claimed signature is settled as signed rather than rejected (with services for its network; otherwise it stays pending) and an answered request only finishes its own answer. A request waiting for its signer is rejected, which needs no RPC services.
async function resolvePendingRequestAsNoResponse(uniqueRequestIdentifier: UniqueRequestIdentifier, services: ConfirmationServices | undefined, websiteTabConnections: WebsiteTabConnections): Promise<boolean | undefined> {
	const context: SafeSignerReplyContext = { services, getInstalledServices: async () => services, websiteTabConnections }
	const advance = async () => await advanceSafeSignerReply(uniqueRequestIdentifier, context)
	return await runSafeSignerReplyLifecycle(uniqueRequestIdentifier, { name: 'advance', retry: advance, run: async () => {
		const state = await advance()
		if (state === 'settled') return true
		if (state !== 'waiting-for-signer') return undefined
		const pending = await getPendingTransactionOrMessageByidentifier(uniqueRequestIdentifier)
		if (pending === undefined) return undefined
		const rejection = {
			...pending.originalRequestParameters,
			...formRejectMessage(METAMASK_ERROR_USER_REJECTED_REQUEST, 'User denied transaction signature'),
			uniqueRequestIdentifier,
		}
		// Claims are only written inside a lifecycle step, so this request is still unclaimed; the storage check refuses the rejection should it not be.
		const rejectionOutcome = await queueTerminalReplyUnlessDeferred(rejection)
		if (rejectionOutcome === 'gone' || rejectionOutcome === 'deferred') return undefined
		const delivery = await deliverQueuedReply(websiteTabConnections, rejection, rejectionOutcome)
		await removeSettledPendingRequest(pending, services)
		return delivery
	} })
}

function schedulePendingNoResponseRetry(transaction: PendingTransactionOrSignableMessage, services: ConfirmationServices | undefined, websiteTabConnections: WebsiteTabConnections) {
	const identifier = getUniqueRequestIdentifierString(transaction.uniqueRequestIdentifier)
	if (pendingNoResponseRetryTimers.has(identifier)) return
	const retryTimer = setTimeout(() => {
		pendingNoResponseRetryTimers.delete(identifier)
		void (async () => {
			try {
				await resolvePendingRequestAsNoResponse(transaction.uniqueRequestIdentifier, services, websiteTabConnections)
			} catch (error) {
				await reportLocalRecovery(error, { code: 'pending_request_no_response_retry_failed', message: 'Retrying a pending popup-close rejection after a transient failure.' })
				schedulePendingNoResponseRetry(transaction, services, websiteTabConnections)
			}
		})()
	}, NO_RESPONSE_RETRY_DELAY_MS)
	pendingNoResponseRetryTimers.set(identifier, retryTimer)
}

const formRejectMessage = (code: number, errorString: string) => {
	return {
		type: 'result' as const,
		error: { code, message: errorString }
	}
}

const resolveInsufficientBalanceMessageForTransaction = async (
	ethereumClientService: EthereumClientService,
	requestAbortController: AbortController | undefined,
	simulationState: Awaited<ReturnType<typeof getUpdatedSimulationState>>,
	transaction: {
		from: bigint
		to: bigint | null
		value: bigint
		input: Uint8Array
	},
	nativeBalancePromise: Promise<bigint>,
) => {
	try {
		const nativeBalance = await nativeBalancePromise
		return await resolveInsufficientBalanceMessage(
			transaction,
			{ balance: nativeBalance, symbol: ethereumClientService.getRpcEntry().currencyTicker, decimals: 18n },
			async (token, owner) => {
				const tokenEntry = await identifyAddress(ethereumClientService, requestAbortController, token)
				if (tokenEntry.type !== 'ERC20') return undefined
				const tokenBalance = await getSimulatedErc20Balance(ethereumClientService, requestAbortController, simulationState, token, owner)
				if (tokenBalance === undefined) return undefined
				return { token, balance: tokenBalance, symbol: tokenEntry.symbol, decimals: tokenEntry.decimals }
			},
		)
	} catch(error: unknown) {
		if (isNewBlockAbort(error)) throw error
		await reportLocalRecovery(error, {
			code: 'insufficient_balance_diagnosis_failed',
			message: 'Keeping the original gas-estimation error because optional balance diagnosis failed.',
		})
		return undefined
	}
}

export const formSendRawTransaction = async(_ethereumClientService: EthereumClientService, sendRawTransactionParams: SendRawTransactionParams, website: Website, created: Date, transactionIdentifier: EthereumQuantity): Promise<WebsiteCreatedEthereumTransaction> => {
	const parsedTransaction = await parseSendRawTransaction(sendRawTransactionParams.params[0])
	return {
		transaction: parsedTransaction.transaction,
		signedTransaction: parsedTransaction.signedTransaction,
		website,
		created,
		originalRequestParameters: sendRawTransactionParams,
		transactionIdentifier,
		success: true,
	}
}

export const formEthSendTransaction = async(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, activeAddress: bigint | undefined, website: Website, sendTransactionParams: SendTransactionParams, created: Date, transactionIdentifier: EthereumQuantity, simulationMode = true, gasPayment: TransactionGasPayment = 'transaction-sender'): Promise<WebsiteCreatedEthereumTransactionOrFailed> => {
	const paidByExecutor = gasPayment !== 'transaction-sender'
	const simulationState = simulationMode || paidByExecutor
		? await getUpdatedSimulationState(ethereumClientService, await captureSimulationSnapshot())
		: PASSTHROUGH_STATE
	const transactionDetails = sendTransactionParams.params[0]
	if (activeAddress === undefined) throw new Error('Access to active address is denied')
	const from = simulationMode && transactionDetails.from !== undefined ? transactionDetails.from : activeAddress
	// Defined by the Safe layer for a transaction the simulation runs as an executor's call (a Gnosis Safe's own call), so this function picks no Safe-specific option or nonce source itself.
	const executedCallFormation = getExecutedCallFormation(ethereumClientService, gasPayment)
	const transactionCountPromise = silenceChromeUnCaughtPromise(executedCallFormation === undefined
		? getSimulatedTransactionCount(ethereumClientService, requestAbortController, simulationState, from)
		: executedCallFormation.getNonce(requestAbortController, simulationState, from))
	const parentBlockPromise = !paidByExecutor
		? silenceChromeUnCaughtPromise(ethereumClientService.getBlock(requestAbortController)) // the latest real block is the parent of the transaction being prepared
		: undefined
	const balancePromise = !paidByExecutor
		? silenceChromeUnCaughtPromise(getSimulatedBalance(ethereumClientService, requestAbortController, simulationState, from))
		: undefined
	const parentBlock = parentBlockPromise === undefined ? undefined : await parentBlockPromise
	if (parentBlock === null) throw new Error('The latest block is null')
	if (parentBlock !== undefined && parentBlock.baseFeePerGas === undefined) throw new Error(CANNOT_SIMULATE_OFF_LEGACY_BLOCK)
	const parentBaseFeePerGas = parentBlock?.baseFeePerGas
	const requestedMaxPriorityFeePerGas = transactionDetails.maxPriorityFeePerGas !== undefined && transactionDetails.maxPriorityFeePerGas !== null ? transactionDetails.maxPriorityFeePerGas : 10n**8n // 0.1 nanoeth/gas
	const maxPriorityFeePerGas = paidByExecutor ? 0n : requestedMaxPriorityFeePerGas
	const value = transactionDetails.value !== undefined  ? transactionDetails.value : 0n
	const getFeePerGas = async (gasLimit: bigint) => {
		if (paidByExecutor) return { maxFeePerGas: 0n, maxPriorityFeePerGas: 0n }
		if (parentBaseFeePerGas === undefined || balancePromise === undefined) throw new Error('Transaction fee context is unavailable')
		return getTransactionFeesForBaseFee(parentBaseFeePerGas, maxPriorityFeePerGas, transactionDetails.maxFeePerGas, await balancePromise, value, gasLimit)
	}
	const getInitialMaxFeePerGas = () => {
		if (paidByExecutor) return 0n
		if (hasExplicitMaxFeePerGas(transactionDetails.maxFeePerGas)) return transactionDetails.maxFeePerGas
		if (parentBaseFeePerGas === undefined) throw new Error('Transaction fee context is unavailable')
		return getDesiredMaxFeePerGasForBaseFee(parentBaseFeePerGas, maxPriorityFeePerGas)
	}
	const transactionWithoutGasBase = {
		from,
		chainId: ethereumClientService.getChainId(),
		nonce: await transactionCountPromise,
		maxFeePerGas: getInitialMaxFeePerGas(),
		maxPriorityFeePerGas,
		to: transactionDetails.to === undefined ? null : transactionDetails.to,
		value,
		input: getInputFieldFromDataOrInput(transactionDetails),
		accessList: transactionDetails.accessList ?? [],
	}
	const transactionWithoutGas = await createEip1559Or7702Transaction(transactionWithoutGasBase, transactionDetails)
	const extraParams = {
		website,
		created,
		originalRequestParameters: sendTransactionParams,
		transactionIdentifier,
		error: undefined,
	}
	// Carried to the confirmation simulation and the simulation stack, which run the Safe's call through its execTransaction.
	const simulationOptionsField: { readonly simulationOptions?: TransactionSimulationOptions } = executedCallFormation === undefined ? {} : { simulationOptions: executedCallFormation.simulationOptions }
	if (transactionDetails.gas === undefined) {
		try {
			if (paidByExecutor && simulationState.kind === 'passthrough') {
				throw new Error('Gnosis Safe transaction gas estimation requires the Interceptor simulator.')
			}
			const estimateGas = executedCallFormation === undefined
				? await simulateEstimateGas(ethereumClientService, requestAbortController, simulationState, transactionWithoutGas)
				: await executedCallFormation.estimateGas(requestAbortController, simulationState, transactionWithoutGas, { website, created, originalRequestParameters: sendTransactionParams, transactionIdentifier })
			if ('error' in estimateGas) {
				const insufficientBalanceMessage = balancePromise === undefined
					? undefined
					: await resolveInsufficientBalanceMessageForTransaction(ethereumClientService, requestAbortController, simulationState, transactionWithoutGas, balancePromise)
				return {
					...extraParams,
					error: insufficientBalanceMessage === undefined ? estimateGas.error : { ...estimateGas.error, message: insufficientBalanceMessage },
					success: false,
				}
			}
			return { transaction: { ...transactionWithoutGas, ...await getFeePerGas(estimateGas.gas), gas: estimateGas.gas }, ...extraParams, ...simulationOptionsField, success: true }
		} catch(error: unknown) {
			if (isNewBlockAbort(error)) throw error
			if (error instanceof JsonRpcResponseError) return { ...extraParams, error: { code: error.code, message: error.message, data: typeof error.data === 'string' ? error.data : '0x' }, success: false }
			await reportLocalRecovery(error, { code: 'transaction_gas_estimation_failed', message: 'Returning a typed RPC error to the requesting page.' })
			if (error instanceof Error) return { ...extraParams, error: { code: 123456, message: error.message, data: 'data' in error && typeof error.data === 'string' ? error.data : '0x' }, success: false }
			return { ...extraParams, error: { code: 123456, message: 'Unknown Error', data: '0x' }, success: false }
		}
	}
	return { transaction: { ...transactionWithoutGas, ...await getFeePerGas(transactionDetails.gas), gas: transactionDetails.gas }, ...extraParams, ...simulationOptionsField, success: true }
}

const getPendingTransactionWindow = async (ethereum: EthereumClientService, tokenPriceService: TokenPriceService, websiteTabConnections: WebsiteTabConnections) => {
	const pendingTransactions = await getPendingTransactionsAndMessages()
	const openConfirmationWindow = await getOpenConfirmationWindow(pendingTransactions)
	if (openConfirmationWindow !== undefined) return openConfirmationWindow
	// No shown request's window is open, so those requests are answered as no-response; requests holding a deferred signature wait for services for their own network.
	await resolveAllPendingTransactionsAndMessageAsNoResponse(getConfirmationWindowRequests(pendingTransactions), { ethereum, tokenPriceService }, websiteTabConnections)
	return await openPopupOrTab({ url: getHtmlFile('confirmTransaction'), type: 'popup', height: 800, width: 600 })
}

export async function openConfirmTransactionDialogForMessage(
	ethereumClientService: EthereumClientService,
	tokenPriceService: TokenPriceService,
	request: InterceptedRequest,
	confirmation: MessageConfirmationRequest,
	simulationMode: boolean,
	activeAddress: bigint | undefined,
	website: Website,
	websiteTabConnections: WebsiteTabConnections,
) {
	const transactionParams = confirmation.parameters
	if (activeAddress === undefined) return { type: 'result' as const, ...ERROR_INTERCEPTOR_NO_ACTIVE_ADDRESS }
	const activeAddressEntry = (await getUserAddressBookEntriesForChainIdMorePreciseFirst(ethereumClientService.getChainId()))
		.find((entry) => entry.address === activeAddress)
	const signerTabState = await getTabState(request.uniqueRequestIdentifier.requestSocket.tabId)
	const simulationSignerAddress = activeAddressEntry?.type === 'safe'
		? simulationMode ? activeAddressEntry.safeSimulationSignerAddress : getWalletSelectedAccount(signerTabState)
		: activeAddress
	if (simulationSignerAddress === undefined) {
		return formRejectMessage(SAFE_SIGNER_SELECTION_ERROR_CODE, simulationMode
			? 'Select a Gnosis Safe signer for simulation before signing a message.'
			: 'Select a current Gnosis Safe owner in the signer wallet before signing a message.')
	}
	const uniqueRequestIdentifierString = getUniqueRequestIdentifierString(request.uniqueRequestIdentifier)
	const messageIdentifier = EthereumQuantity.parse(keccak256(stringToBytes(uniqueRequestIdentifierString)))
	const created = new Date()
	const safeMessage = transactionParams.method === 'eth_signTypedData_v4' && confirmation.review !== undefined
		? SafeMessage.parse({ typedData: transactionParams.params[1], review: confirmation.review }) : undefined
	const signedMessageTransaction = {
		website,
		created,
		activeAddress,
		originalRequestParameters: transactionParams,
		fakeSignedFor: simulationSignerAddress,
		simulationMode,
		request,
		messageIdentifier,
		...(safeMessage === undefined ? {} : { safeMessageReview: safeMessage.review }),
	}
	try {
		const visualizedPersonalSignRequest = await craftPersonalSignPopupMessage(ethereumClientService, undefined, signedMessageTransaction, ethereumClientService.getRpcEntry())
		const walletSignerAddress = getWalletSelectedAccount(signerTabState)
		let safeMessageCoSignSnapshot: Awaited<ReturnType<typeof createSafeMessageCoSignSnapshot | typeof createSafeOffChainMessageSnapshot>> | undefined
			let safeMessageValidationError: string | undefined
			let safeMessageValidationDetails: SafeSignerErrorDetails | undefined
		if (!simulationMode && activeAddressEntry?.type === 'safe' && (visualizedPersonalSignRequest.type === 'SafeTx' || isSafeMessageCoSignRequest(transactionParams, activeAddress, ethereumClientService.getChainId(), confirmation.review))) {
				try {
					safeMessageCoSignSnapshot = visualizedPersonalSignRequest.type === 'SafeTx'
						? await createSafeMessageCoSignSnapshot(ethereumClientService, activeAddress, walletSignerAddress, transactionParams, visualizedPersonalSignRequest.message)
						: await createSafeOffChainMessageSnapshot(ethereumClientService, activeAddress, walletSignerAddress, transactionParams, safeMessage?.review)
				} catch (error) {
					if (!isExpectedSafeMessageCoSignSnapshotFailure(error)) throw error
					safeMessageValidationError = getErrorMessage(error) ?? 'The Gnosis Safe transaction could not be validated.'
					safeMessageValidationDetails = isSafeMessageAccountMismatchFailure(error) ? error.safeSignerErrorDetails : undefined
			}
		}
		await pendingConfirmationSemaphore.execute(async () => {
			const openedDialog = await getPendingTransactionWindow(ethereumClientService, tokenPriceService, websiteTabConnections)
			if (openedDialog === undefined) throw new Error('Failed to get pending transaction window!')

			const pendingMessage = {
				type: 'SignableMessage' as const,
				popupOrTabId: openedDialog,
				originalRequestParameters: transactionParams,
				uniqueRequestIdentifier: request.uniqueRequestIdentifier,
				simulationMode,
				activeAddress,
				created,
				transactionOrMessageCreationStatus: 'Crafting' as const,
				website,
				approvalStatus: safeMessageValidationError === undefined
					? { status: 'WaitingForUser' as const }
					: createSafeSignerErrorStatus(safeMessageValidationError, SAFE_SIGNER_SELECTION_ERROR_CODE, safeMessageValidationDetails),
				signedMessageTransaction,
				...(safeMessageCoSignSnapshot === undefined ? {} : { safeMessageCoSignSnapshot }),
			}
			await appendPendingTransactionOrMessage(pendingMessage)
			await updateConfirmTransactionView(ethereumClientService, tokenPriceService)

			await updatePendingTransactionOrMessage(pendingMessage.uniqueRequestIdentifier, async (message) => {
				if (message.type !== 'SignableMessage') return message
				return modifyObject(message, { transactionOrMessageCreationStatus: 'Simulating' as const } )
			})
			await updateConfirmTransactionView(ethereumClientService, tokenPriceService)

			await updatePendingTransactionOrMessage(pendingMessage.uniqueRequestIdentifier, async (message) => {
				if (message.type !== 'SignableMessage') return message
				return { ...message, visualizedPersonalSignRequest, transactionOrMessageCreationStatus: 'Simulated' as const }
			})
			await updateConfirmTransactionView(ethereumClientService, tokenPriceService)

			await tryFocusingTabOrWindow(openedDialog)
			if (visualizedPersonalSignRequest.type === 'SafeTx') {
				await simulateGnosisSafeTransactionOnPass(ethereumClientService, tokenPriceService, visualizedPersonalSignRequest)
			}
		})
	} catch(e) {
		if (isSafeSignerSelectionFailure(e)) {
			return formRejectMessage(SAFE_SIGNER_SELECTION_ERROR_CODE, getErrorMessage(e) ?? 'Select a current Gnosis Safe owner in the signer wallet before co-signing.')
		}
		await reportUnexpectedError(e)
		return formRejectMessage(METAMASK_ERROR_BLANKET_ERROR, 'Failed to process message signing request. See Interceptor for error message')
	}
	const pendingTransactionData = await getPendingTransactionOrMessageByidentifier(request.uniqueRequestIdentifier)
	if (pendingTransactionData === undefined) return formRejectMessage(METAMASK_ERROR_BLANKET_ERROR, 'The Interceptor failed to process the transaction')
	return { type: 'doNotReply' as const }
}

export async function openConfirmTransactionDialogForTransaction(
	ethereumClientService: EthereumClientService,
	tokenPriceService: TokenPriceService,
	request: InterceptedRequest,
	confirmation: TransactionConfirmationRequest,
	simulationMode: boolean,
	activeAddress: bigint | undefined,
	website: Website,
	websiteTabConnections: WebsiteTabConnections,
) {
	const uniqueRequestIdentifierString = getUniqueRequestIdentifierString(request.uniqueRequestIdentifier)
	const transactionIdentifier = EthereumQuantity.parse(keccak256(stringToBytes(uniqueRequestIdentifierString)))
	const created = new Date()
	if (activeAddress === undefined) return { type: 'result' as const, ...ERROR_INTERCEPTOR_NO_ACTIVE_ADDRESS }
	const signerTabState = await getTabState(request.uniqueRequestIdentifier.requestSocket.tabId)
	const walletSignerAddress = getWalletSelectedAccount(signerTabState)
	const safePreparation = await prepareSafeTransactionConfirmation(
		ethereumClientService,
		confirmation,
		simulationMode,
		activeAddress,
		walletSignerAddress,
	)
	if (safePreparation.rejection !== undefined) {
		return formRejectMessage(safePreparation.rejection.code, safePreparation.rejection.message)
	}
	const {
		effectiveTransactionParams,
		transactionExecutor,
		gasPayment,
		preparationMessage: safePreparationMessage,
	} = safePreparation
	const transactionToSimulatePromise = safePreparationMessage !== undefined
		? Promise.resolve({
			website,
			created,
			originalRequestParameters: effectiveTransactionParams,
			transactionIdentifier,
			success: false as const,
			error: {
				code: METAMASK_ERROR_FAILED_TO_PARSE_REQUEST,
				message: safePreparationMessage,
			},
		})
		: effectiveTransactionParams.method === 'eth_sendTransaction'
		? formEthSendTransaction(
			ethereumClientService,
			undefined,
			transactionExecutor,
			website,
			effectiveTransactionParams,
			created,
			transactionIdentifier,
			simulationMode,
			gasPayment,
		)
		: formSendRawTransaction(ethereumClientService, effectiveTransactionParams, website, created, transactionIdentifier)
	silenceChromeUnCaughtPromise(transactionToSimulatePromise)
	const outcome = await pendingConfirmationSemaphore.execute(async () => {
		const finalizedSafePreparation = await safePreparation.finalize(
			await transactionToSimulatePromise,
			request.uniqueRequestIdentifier.requestSocket.tabId,
		)
		try {
			const { transactionToSimulate, safeTransaction, approvalStatus: safeSignerMismatch, pendingSafeFields } = finalizedSafePreparation
			const openedDialog = await getPendingTransactionWindow(ethereumClientService, tokenPriceService, websiteTabConnections)
			if (openedDialog === undefined) return formRejectMessage(METAMASK_ERROR_FAILED_TO_PARSE_REQUEST, 'Failed to get pending transaction window')
			markPerformance(POPUP_PERFORMANCE_MARKS.backgroundTransactionConfirmPopupOpened)

			const pendingTransaction = {
				type: 'Transaction' as const,
				popupOrTabId: openedDialog,
				originalRequestParameters: effectiveTransactionParams,
				uniqueRequestIdentifier: request.uniqueRequestIdentifier,
				simulationMode,
				activeAddress: transactionExecutor,
				created,
				transactionOrMessageCreationStatus: 'Crafting' as const,
				transactionIdentifier,
				website,
				approvalStatus: safeSignerMismatch ?? { status: 'WaitingForUser' as const },
				...(safeTransaction === undefined ? {} : { safeTransaction }),
				...(pendingSafeFields ?? {}),
			}
			await appendPendingTransactionOrMessage(pendingTransaction)
			await updateConfirmTransactionView(ethereumClientService, tokenPriceService)
			markPerformance(POPUP_PERFORMANCE_MARKS.backgroundTransactionSimulationStart)
			const simulationResultsPromise = silenceChromeUnCaughtPromise(refreshConfirmTransactionSimulation(
				ethereumClientService,
				tokenPriceService,
				transactionExecutor,
				simulationMode,
				request.uniqueRequestIdentifier,
				transactionToSimulate,
				safeTransaction,
			))
			if (transactionToSimulate.success) {
				await updatePendingTransactionOrMessage(pendingTransaction.uniqueRequestIdentifier, async (transaction) => ({ ...transaction, transactionToSimulate: transactionToSimulate, transactionOrMessageCreationStatus: 'Simulating' as const }))
				await updateConfirmTransactionView(ethereumClientService, tokenPriceService)
			}
			const popupVisualisation = await simulationResultsPromise
			markPerformance(POPUP_PERFORMANCE_MARKS.backgroundTransactionSimulationEnd)
			await updatePendingTransactionOrMessage(pendingTransaction.uniqueRequestIdentifier, async (transaction) => {
				if (transaction.type !== 'Transaction') return transaction
				if (popupVisualisation === undefined) return transaction
				if (transaction.transactionOrMessageCreationStatus === 'Simulated' || transaction.transactionOrMessageCreationStatus === 'FailedToSimulate') {
					if ('popupVisualisation' in transaction && !shouldReplacePopupVisualisation(transaction.popupVisualisation, popupVisualisation)) return transaction
				}
				if (transactionToSimulate.success) return { ...transaction, transactionToSimulate, popupVisualisation, transactionOrMessageCreationStatus: 'Simulated' }
				return { ...transaction, transactionToSimulate, popupVisualisation, transactionOrMessageCreationStatus: 'FailedToSimulate' }
			})
			await updateConfirmTransactionView(ethereumClientService, tokenPriceService)
			await tryFocusingTabOrWindow(openedDialog)
			return { success: true }
		} catch(e: unknown) {
			await reportLocalRecovery(e, { code: 'send_transaction_preparation_failed', message: 'Returning a wallet-compatible rejection to the requesting page.', details: e instanceof Error ? e.stack : undefined })
			return formRejectMessage(METAMASK_ERROR_FAILED_TO_PARSE_REQUEST, 'The Interceptor failed to send transaction')
		}
	})
	if (!('success' in outcome)) return formRejectMessage(outcome.error.code, outcome.error.message)
	const pendingTransactionData = await getPendingTransactionOrMessageByidentifier(request.uniqueRequestIdentifier)

	if (pendingTransactionData === undefined) return formRejectMessage(METAMASK_ERROR_BLANKET_ERROR, 'The Interceptor failed to process the transaction')
	return { type: 'doNotReply' as const }
}
