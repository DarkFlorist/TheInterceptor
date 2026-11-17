import type { MessageConfirmationRequest, TransactionConfirmationRequest } from '../../types/confirmationRequest.js'
import { SafeMessage } from '../../safe/safeMessage.js'
import { isSafeMessageCoSignRequest } from '../../safe/safeRequestPolicy.js'
import type { EthereumClientService } from '../../simulation/services/EthereumClientService.js'
import { getInputFieldFromDataOrInput, getSimulatedBalance, getSimulatedErc20Balance, getSimulatedTransactionCount, simulateEstimateGas } from '../../simulation/services/SimulationModeEthereumClientService.js'
import { toPreSimulationTransaction } from '../../simulation/services/simulationTransactionSigning.js'
import { CANNOT_SIMULATE_OFF_LEGACY_BLOCK, ERROR_INTERCEPTOR_NO_ACTIVE_ADDRESS, METAMASK_ERROR_BLANKET_ERROR, METAMASK_ERROR_FAILED_TO_PARSE_REQUEST } from '../../utils/constants.js'
import type { WebsiteTabConnections } from '../../types/user-interface-types.js'
import type { SendRawTransactionParams, SendTransactionParams } from '../../types/JsonRpc-types.js'
import { createInterruptedConfirmTransactionSimulation, refreshConfirmTransactionSimulation } from '../confirmTransactionSimulation.js'
import { captureSimulationSnapshot, getExecutedCallFormation, getUpdatedSimulationState } from '../simulationUpdating.js'
import { getHtmlFile, getWebsiteSocketRequestOrigin, sendPopupMessageToOpenWindows } from '../backgroundUtils.js'
import { appendPendingTransactionOrMessage, getInterceptorTransactionStack, getPendingTransactionsAndMessages, getRpcConnectionStatus, getTabState, getUserAddressBookEntriesForChainIdMorePreciseFirst, updateInterceptorTransactionStack, updatePendingTransactionOrMessage, updateInterceptorTransactionStackWithResult } from '../storageVariables.js'
import { type InterceptedRequest, type UniqueRequestIdentifier, doesUniqueRequestIdentifiersMatch, getUniqueRequestIdentifierString, silenceChromeUnCaughtPromise } from '../../utils/requests.js'
import { replyToInterceptedRequestAfterManifestV2Reconnect } from '../messageSending.js'
import { getQueuedTerminalReply } from '../terminalReplyDelivery.js'
import { stringToBytes, keccak256 } from '../../utils/ethereumPrimitives.js'
import { EthereumQuantity, serialize } from '../../types/wire-types.js'
import type { PopupOrTabId, Website } from '../../types/websiteAccessTypes.js'
import { getErrorMessage, JsonRpcResponseError, reportUnexpectedError, isExpectedInfrastructureError, isNewBlockAbort, reportLocalRecovery } from '../../utils/errors.js'
import { type PendingTransactionOrSignableMessage, type PopupPendingTransactionOrSignableMessage, type SimulatedPendingTransaction, withoutOwnedFields } from '../../types/accessRequest.js'
import type { SignMessageParams } from '../../types/jsonRpc-signing-types.js'
import { type TransactionConfirmation, UpdateConfirmTransactionDialog, UpdateConfirmTransactionDialogPendingTransactions } from '../../types/interceptor-messages.js'
import type { InterceptedRequestForward } from '../../types/interceptor-messages.js'
import type { SimulationStackChange } from '../../types/visualizer-types.js'
import { type InterceptorTransactionStack, PASSTHROUGH_STATE, type PreSimulationTransaction, type TransactionGasPayment, type TransactionSimulationOptions, type WebsiteCreatedEthereumTransaction, type WebsiteCreatedEthereumTransactionOrFailed, createPassthroughCompleteVisualizedSimulation } from '../../types/visualizer-types.js'
import type { SafeSignerErrorDetails, SafeTransactionRequestContext } from '../../types/safeTypes.js'
import { craftPersonalSignPopupMessage } from './personalSign.js'
import { getSettings } from '../settings.js'
import * as funtypes from 'funtypes'
import { assertNever, modifyObject } from '../../utils/typescript.js'
import { simulateGnosisSafeTransactionOnPass } from '../popupMessageHandlers.js'
import { updatePopupVisualisationIfNeeded } from '../popupVisualisationUpdater.js'
import { POPUP_PERFORMANCE_MARKS, markPerformance } from '../../utils/popupPerformance.js'
import type { TokenPriceService } from '../../simulation/services/priceEstimator.js'
import { getPopupOrTabById, openPopupOrTab, tryFocusingTabOrWindow } from '../../utils/popupOrTab.js'
import { getDesiredMaxFeePerGasForBaseFee, getTransactionFeesForBaseFee, hasExplicitMaxFeePerGas } from '../../utils/transactionFees.js'
import { parseSendRawTransaction } from '../../utils/sendRawTransactionParsing.js'
import { createEip1559Or7702Transaction } from '../../utils/eip7702Authorization.js'
import { identifyAddress } from '../metadataUtils.js'
import { resolveInsufficientBalanceMessage } from '../../utils/insufficientBalance.js'
import { prepareSafeTransactionConfirmation, type SafeTransactionConfirmationPreparation } from '../safeTransactionConfirmation.js'
import { createSafeMessageCoSignSnapshot, getPendingSafeSignerAddress, getSafeSignerMismatchApprovalStatus, isExpectedSafeMessageCoSignSnapshotFailure, isSafeMessageAccountMismatchFailure, isSafeSignerSelectionFailure, resolveSafeConfirmation, SAFE_SIGNER_SELECTION_ERROR_CODE, type RefreshedSafeSignerSelection } from '../safeConfirmationResolver.js'
import { createSafeOffChainMessageSnapshot, refreshAndPersistSafeSignerSelection } from '../safeSignerSelectionRefresh.js'
import { getCreatedSafeProposal, getSafePendingFlow, getSafeTransactionFlowGasPayment } from '../../safe/safePendingFlow.js'
import { persistUnsignedSafeTransaction, resolveSafeSignerReply } from '../safeConfirmationPersistence.js'
import { getWalletSelectedAccount } from '../../utils/activeAddressSelection.js'
import { createSafeSignerErrorStatus } from '../safeSignerErrors.js'
import { getSendAnywayOverrideReason, isRejectOnlyTransaction } from '../../utils/sendAnywayConsent.js'
import { getReviewedResultId } from '../reviewedResult.js'
import { type PendingConfirmationLock, runConfirmationViewStep, withPendingConfirmationLock } from '../confirmationWindowLifecycle.js'
import { type ResolutionContext, type ResolutionScope, commitAndFinish, declineOrphanedRequestsAtStartup, declinePendingRequests, declineRequest, formRejectMessage, resetRequestRetryBudget, resolveRequestsOfClosedWindow, resumeRequest, submitSignerResult, toStackedTerminalReply, toTerminalReply, withResolutionClaim } from '../requestResolution.js'
import { findStackOperation, getRequestStackIdentifier, isStackOperationOf } from '../requestStackIdentity.js'

// Safe proposal formation and window registration share one confirmation lock.
export const runWithPendingConfirmationLock = async <T>(work: () => Promise<T>) => await withPendingConfirmationLock(work)

type StoredConfirmation = Pick<PendingTransactionOrSignableMessage, 'popupOrTabId' | 'uniqueRequestIdentifier'>

// Removes a confirmation whose opening failed through the same durable decline path as a closed popup.
async function removeConfirmationOfRejectedRequest(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, request: StoredConfirmation, websiteTabConnections: WebsiteTabConnections, pendingConfirmationLock: PendingConfirmationLock) {
	await declineRequest(request.uniqueRequestIdentifier, 'close', createResolutionContext(ethereum, tokenPriceService, websiteTabConnections), { pendingConfirmationLock })
}

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
		getSafeTransactionFlowGasPayment(flow.kind),
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

// Keeps a simulation that started later than the new confirmation's; see "Confirmation dialog staleness" in docs/popup-simulation-refresh.md for the other guards.
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
			return { ...pending, reviewedResultId: getReviewedResultId(pending) }
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
				reviewedResultId: getReviewedResultId(pending),
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
		const settingsPromise = getSettings()
		const currentBlockNumberPromise = silenceChromeUnCaughtPromise(ethereum.getBlockNumber(undefined))
		const rpcConnectionStatusPromise = silenceChromeUnCaughtPromise(getRpcConnectionStatus())
		const pendingTransactionAndSignableMessages = await getPendingTransactionsAndMessages()
		if (pendingTransactionAndSignableMessages.length === 0) return false
		const settings = await settingsPromise
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

export const isConfirmTransactionFocused = async () => {
	const pendingTransactions = await getPendingTransactionsAndMessages()
	if (pendingTransactions[0] === undefined) return false
	const popup = await getPopupOrTabById(pendingTransactions[0].popupOrTabId)
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
		const theTransactionIsAlreadyInStack = findStackOperation((await getInterceptorTransactionStack()).operations, { type: 'Transaction', transactionIdentifier }) !== undefined
		if (!theTransactionIsAlreadyInStack) return undefined
		await updateInterceptorTransactionStack((prevStack: InterceptorTransactionStack) => {
			return { operations: prevStack.operations.map((operation) => {
				if (operation.type !== 'Transaction' || !isStackOperationOf(operation, { type: 'Transaction', transactionIdentifier })) return operation
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

// An accept authorizes only the stored request whose reviewed content the user saw. A transaction without a reviewable result cannot be accepted at all, and a failing or quarantined result also needs the send-anyway override.
function isAcceptForStoredResult(pending: PendingTransactionOrSignableMessage, accept: { reviewedResultId: string, forceSend: boolean }) {
	if (getReviewedResultId(pending) !== accept.reviewedResultId) return false
	if (isRejectOnlyTransaction(pending)) return false
	return accept.forceSend || getSendAnywayOverrideReason(pending) === undefined
}

// Checks the accept against the stored request and claims it in the same locked storage update, so a refresh committed in between cannot become the accepted request. Signing-mode requests move to WaitingForSigner; simulation-mode ones are removed once added to the simulation. Returns the accepted snapshot, or undefined when the accept no longer matches.
async function claimAcceptedRequest(accept: Extract<TransactionConfirmation['data'], { action: 'accept' }>) {
	let acceptedPending: PendingTransactionOrSignableMessage | undefined
	await updatePendingTransactionOrMessage(accept.uniqueRequestIdentifier, async (current) => {
		if (current.transactionOrMessageCreationStatus !== 'Simulated' || !isAcceptForStoredResult(current, accept)) return undefined
		acceptedPending = current.simulationMode ? current : modifyObject(current, { approvalStatus: { status: 'WaitingForSigner' as const } })
		return acceptedPending === undefined ? undefined : withoutOwnedFields(acceptedPending)
	})
	return acceptedPending
}

type SimulationServices = { readonly ethereum: EthereumClientService, readonly tokenPriceService: TokenPriceService }

// #1650's order holds: the website's answer never waits for view work. Finishing commits and delivers the reply before it removes the request and updates its window (retried, per window); the simulation stack view is updated after that, best effort.
async function commitReplyAndShowStackChange({ ethereum, tokenPriceService }: SimulationServices, request: PendingTransactionOrSignableMessage, terminalReply: InterceptedRequestForward, simulationStack: SimulationStackChange, context: ResolutionContext, scope: ResolutionScope) {
	try {
		return await commitAndFinish(request, terminalReply, context, scope)
	} finally {
		await runConfirmationViewStep(async () => await showSimulationStackChange(ethereum, tokenPriceService, simulationStack))
	}
}

// Settles a signer's result under the request's claim, for the request as stored now (SignerResultSettlement): a request that never finished simulating is answered as unprocessable; a Gnosis Safe owner signature is persisted with its proposal, or refused with the reason shown in the window; any other result is the website's reply. A request in simulation mode never went to a signer, so a result for it is ignored.
async function settleSignerResult(services: SimulationServices, request: PendingTransactionOrSignableMessage, signerReply: string, context: ResolutionContext, scope: ResolutionScope) {
	if (request.transactionOrMessageCreationStatus !== 'Simulated') return await commitReplyAndShowStackChange(services, request, toTerminalReply(request, formRejectMessage(METAMASK_ERROR_BLANKET_ERROR, 'The Interceptor failed to process the transaction')), 'unchanged', context, scope)
	if (request.simulationMode) return false
	const safeReply = await resolveSafeSignerReply(services.ethereum, request, signerReply)
	if (safeReply.status === 'error') {
		await updatePendingTransactionOrMessage(request.uniqueRequestIdentifier, async (pending) => modifyObject(pending, {
			approvalStatus: safeReply.approvalStatus,
		}))
		await context.refreshConfirmationWindow()
		return false
	}
	if (safeReply.status === 'success') return await commitReplyAndShowStackChange(services, request, toTerminalReply(request, { type: 'result', result: safeReply.result }), safeReply.simulationStack, context, scope)
	return await commitReplyAndShowStackChange(services, request, toTerminalReply(request, { type: 'result', result: signerReply }), 'unchanged', context, scope)
}

// The context of a resolution, whose service-dependent steps get the simulation services when they run: the background's services may not exist yet, when getServices throws and the step is retried.
export const createResolutionContextWithServices = (getServices: () => SimulationServices, websiteTabConnections: WebsiteTabConnections): ResolutionContext => ({
	websiteTabConnections,
	refreshConfirmationWindow: async () => {
		const { ethereum, tokenPriceService } = getServices()
		return await updateConfirmTransactionView(ethereum, tokenPriceService)
	},
	settleSignerResult: async (request, signerReply, context, scope) => await settleSignerResult(getServices(), request, signerReply, context, scope),
})

// The context of a resolution started with the simulation services at hand.
export const createResolutionContext = (ethereum: EthereumClientService, tokenPriceService: TokenPriceService, websiteTabConnections: WebsiteTabConnections) => createResolutionContextWithServices(() => ({ ethereum, tokenPriceService }), websiteTabConnections)

export async function resolvePendingTransactionOrMessage(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, websiteTabConnections: WebsiteTabConnections, confirmation: TransactionConfirmation, refreshedSafeSignerSelection?: RefreshedSafeSignerSelection) {
	// A user's action on the request gives its resolution a new retry budget; a signer's result is no user action.
	if (confirmation.data.action !== 'signerIncluded') resetRequestRetryBudget(confirmation.data.uniqueRequestIdentifier)
	return await resolvePendingRequest(ethereum, tokenPriceService, createResolutionContext(ethereum, tokenPriceService, websiteTabConnections), confirmation, refreshedSafeSignerSelection)
}

async function resolvePendingRequest(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, resolutionContext: ResolutionContext, confirmation: TransactionConfirmation, refreshedSafeSignerSelection?: RefreshedSafeSignerSelection) {
	// A reject and a closed window are one decline, with its own retries.
	if (confirmation.data.action === 'reject' || confirmation.data.action === 'noResponse') return await declineRequest(confirmation.data.uniqueRequestIdentifier, confirmation.data.action === 'reject' ? 'reject' : 'close', resolutionContext)
	// A signer's result, the transaction hash or signature string it answered with, is stored with the request before any lookup that can fail, and settled under the request's claim (settleSignerResult).
	if (confirmation.data.action === 'signerIncluded') return await submitSignerResult(confirmation.data.uniqueRequestIdentifier, funtypes.String.parse(confirmation.data.signerReply), resolutionContext)
	// A request committed to a reply is only finished, whatever the action, so an accept never follows a delivered rejection. Checked before the pending request is looked up: a request whose finishing removed it but ran out of retries for its window update still has a committed reply to finish.
	if (await getQueuedTerminalReply(confirmation.data.uniqueRequestIdentifier) !== undefined) return await resumeRequest(confirmation.data.uniqueRequestIdentifier, resolutionContext)
	if (confirmation.data.action === 'accept') return await withResolutionClaim(confirmation.data.uniqueRequestIdentifier, resolutionContext, async () => await resolveUncommittedRequest(ethereum, tokenPriceService, resolutionContext, confirmation, refreshedSafeSignerSelection))
	return await resolveUncommittedRequest(ethereum, tokenPriceService, resolutionContext, confirmation, refreshedSafeSignerSelection)
}

// Accepts enter with the resolution claim already held, before checking consent or updating signer status. Safe proposal actions retain their preflight and take the claim at persistence below.
async function resolveUncommittedRequest(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, resolutionContext: ResolutionContext, confirmation: TransactionConfirmation, refreshedSafeSignerSelection?: RefreshedSafeSignerSelection) {
	const { websiteTabConnections } = resolutionContext
	let pendingTransactionOrMessage = await getPendingTransactionOrMessageByidentifier(confirmation.data.uniqueRequestIdentifier)
	if (pendingTransactionOrMessage === undefined) return // no need to resolve as it doesn't exist anymore
	if (confirmation.data.action === 'accept' && !isAcceptForStoredResult(pendingTransactionOrMessage, confirmation.data)) {
		// Keep the request pending and redraw the popup, so the user reviews the current result before accepting again.
		await updateConfirmTransactionView(ethereum, tokenPriceService)
		return false
	}
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
		await updatePendingTransactionOrMessage(confirmation.data.uniqueRequestIdentifier, async () => withoutOwnedFields(safeResolution.pending))
		await updateConfirmTransactionView(ethereum, tokenPriceService)
		return false
	}
	pendingTransactionOrMessage = safeResolution.pending
	if (safeResolution.pendingChanged) {
		await updatePendingTransactionOrMessage(confirmation.data.uniqueRequestIdentifier, async () => withoutOwnedFields(safeResolution.pending))
	}
	if (confirmation.data.action === 'accept') {
		// The Safe signer refresh and resolution above, or a concurrent result refresh, may have stored new content, so the accept is checked again while claiming the request.
		const acceptedPending = await claimAcceptedRequest(confirmation.data)
		if (acceptedPending === undefined) {
			await updateConfirmTransactionView(ethereum, tokenPriceService)
			return false
		}
		// The claimed snapshot has the reviewed content, so forwarding it is unaffected by refreshes stored after the claim.
		pendingTransactionOrMessage = acceptedPending
	}
	const signerFacingRequest: SendTransactionParams | SendRawTransactionParams | SignMessageParams = safeResolution.signerFacingRequest
		?? pendingTransactionOrMessage.originalRequestParameters
	const replyWith = async (terminalReply: InterceptedRequestForward, simulationStack: SimulationStackChange) => await commitReplyAndShowStackChange({ ethereum, tokenPriceService }, pendingTransactionOrMessage, terminalReply, simulationStack, resolutionContext, {})
	// The request as the Gnosis Safe resolution above left it, which adding it to its Gnosis Safe stack persists.
	const requestAsReviewed = pendingTransactionOrMessage
	// Every path that persists an outcome (a Gnosis Safe proposal, a forward to the signer, a stacked request; a signer's result, by submitSignerResult) or commits a reply runs under the request's resolution claim, which first finishes a committed request and runs the path only for one still pending and uncommitted. So a reject that won never sees a later success, and a reject arriving meanwhile is deferred to the claim's release, where the commitment wins.
	if (confirmation.data.action === 'addToSafeStack') return await withResolutionClaim(confirmation.data.uniqueRequestIdentifier, resolutionContext, async (current) => {
		if (current.approvalStatus.status === 'WaitingForSigner') return false
		const safeReply = await persistUnsignedSafeTransaction(ethereum, requestAsReviewed)
		if (safeReply.status === 'error') {
			await updatePendingTransactionOrMessage(confirmation.data.uniqueRequestIdentifier, async (pending) => modifyObject(pending, {
				approvalStatus: safeReply.approvalStatus,
			}))
			await updateConfirmTransactionView(ethereum, tokenPriceService)
			return false
		}
		if (safeReply.status === 'success') return await replyWith(toTerminalReply(pendingTransactionOrMessage, { type: 'result', result: safeReply.result }), safeReply.simulationStack)
		return false
	})
	if (
		confirmation.data.action === 'accept'
		&& pendingTransactionOrMessage.transactionOrMessageCreationStatus !== 'Simulated'
	) return false
	if (confirmation.data.action === 'accept' && pendingTransactionOrMessage.simulationMode === false) {
		await updatePendingTransactionOrMessage(confirmation.data.uniqueRequestIdentifier, async (transaction) => modifyObject(transaction, { approvalStatus: { status: 'WaitingForSigner' } }))
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
	// Only an accept of a simulated request in simulation mode is left: a reject, close or signer result was handled first, and an accept of an unsimulated request or one outside simulation mode returned above.
	if (pendingTransactionOrMessage.transactionOrMessageCreationStatus !== 'Simulated' || !pendingTransactionOrMessage.simulationMode) return false
	// Accepting stacks the request and replies only if it wins the request's resolution (withResolutionClaim).
	const simulatedPending = pendingTransactionOrMessage
	switch (simulatedPending.type) {
		case 'SignableMessage': {
			// A message an earlier accept already stacked before stopping is not stacked again.
			await updateInterceptorTransactionStack((prevStack: InterceptorTransactionStack) => findStackOperation(prevStack.operations, getRequestStackIdentifier(simulatedPending)) !== undefined
				? prevStack
				: { operations: [...prevStack.operations, { type: 'Message' as const, signedMessageTransaction: simulatedPending.signedMessageTransaction }] })
			return await replyWith(await toStackedTerminalReply(simulatedPending, { type: 'Message', signedMessageTransaction: simulatedPending.signedMessageTransaction }), 'changed')
		}
		case 'Transaction': {
			// Repeated accepts return the operation already stacked by this request.
			const pendingTransaction = simulatedPending
			const current = (await getPendingTransactionsAndMessages()).find((request) => doesUniqueRequestIdentifiersMatch(request.uniqueRequestIdentifier, pendingTransaction.uniqueRequestIdentifier))
			if (current?.type !== 'Transaction') return false
			const transactionToStack = toPreSimulationTransaction(pendingTransaction.transactionToSimulate)
			const transaction = await updateInterceptorTransactionStackWithResult<PreSimulationTransaction>((prevStack) => {
				const alreadyStacked = findStackOperation(prevStack.operations, { type: 'Transaction', transactionIdentifier: pendingTransaction.transactionIdentifier })
				if (alreadyStacked !== undefined) return { stack: prevStack, result: alreadyStacked.preSimulationTransaction }
				return { stack: { operations: [...prevStack.operations, { type: 'Transaction', preSimulationTransaction: transactionToStack }] }, result: transactionToStack }
			})
			markPerformance(POPUP_PERFORMANCE_MARKS.backgroundTransactionStackAppended)
			return await replyWith(await toStackedTerminalReply(simulatedPending, { type: 'Transaction', preSimulationTransaction: transaction }), 'changed')
		}
		default: assertNever(simulatedPending)
	}
}

export const onCloseWindowOrTab = async (popupOrTabs: PopupOrTabId, ethereum: EthereumClientService, tokenPriceService: TokenPriceService, websiteTabConnections: WebsiteTabConnections) => await resolveRequestsOfClosedWindow(popupOrTabs, createResolutionContext(ethereum, tokenPriceService, websiteTabConnections))

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
	await declineOrphanedRequestsAtStartup(orphanedTransactions, createResolutionContext(ethereum, tokenPriceService, websiteTabConnections))
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
	// Defined by the Safe layer for a transaction the simulation runs as an executor's call (a Gnosis Safe proposal, or in simulation mode a Safe's own call), so this function picks no Safe-specific option or nonce source itself.
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

// The transaction or message identifier of one request, unique even when a page reuses a request id: what is stacked for a request carries it, so finding it on the stack proves this request stacked it (rejectUnlessStacked, accepting again).
const createRequestIdentity = (uniqueRequestIdentifier: UniqueRequestIdentifier) => EthereumQuantity.parse(keccak256(stringToBytes(`${ getUniqueRequestIdentifierString(uniqueRequestIdentifier) }-${ crypto.randomUUID() }`)))

const openConfirmationWindow = async () => await openPopupOrTab({ url: getHtmlFile('confirmTransaction'), type: 'popup', height: 800, width: 600 })
// Called under the pending-confirmation lock (confirmationWindowLifecycle.ts). Requests whose window is gone are rejected as for a window the user closed, by resolutions that know the lock is held.
const getPendingTransactionWindow = async (ethereum: EthereumClientService, tokenPriceService: TokenPriceService, websiteTabConnections: WebsiteTabConnections, pendingConfirmationLock: PendingConfirmationLock) => {
	// Each request is checked against its own window: requests whose window is gone are rejected, and a live confirmation window of another request is reused.
	let liveWindow: Awaited<ReturnType<typeof getPopupOrTabById>>
	const orphanedRequests: PendingTransactionOrSignableMessage[] = []
	for (const pending of await getPendingTransactionsAndMessages()) {
		const window = await getPopupOrTabById(pending.popupOrTabId)
		if (window === undefined) orphanedRequests.push(pending)
		else liveWindow ??= window
	}
	if (orphanedRequests.length > 0) await declinePendingRequests(orphanedRequests, createResolutionContext(ethereum, tokenPriceService, websiteTabConnections), { pendingConfirmationLock })
	return liveWindow ?? await openConfirmationWindow()
}

type ConfirmationOpeningResult = { readonly type: 'doNotReply' } | { readonly type: 'result', readonly error: { readonly code: number, readonly message: string } }
const confirmationOpenings = new Map<string, Promise<ConfirmationOpeningResult>>()

// Bridge deduplication tracks deliveries; this admission owns one confirmation per logical request, including direct callers and a pending request restored after restart. Coalesce concurrent opens before any preparation, and leave an existing pending request to answer its own page promise.
function openPendingConfirmationOnce(identifier: UniqueRequestIdentifier, open: () => Promise<ConfirmationOpeningResult>): Promise<ConfirmationOpeningResult> {
	const key = getUniqueRequestIdentifierString(identifier)
	const existing = confirmationOpenings.get(key)
	if (existing !== undefined) return existing
	const opening = Promise.resolve().then(async (): Promise<ConfirmationOpeningResult> => {
		if (await getPendingTransactionOrMessageByidentifier(identifier) !== undefined) return { type: 'doNotReply' }
		return await open()
	})
	const completed = opening.finally(() => {
		if (confirmationOpenings.get(key) === completed) confirmationOpenings.delete(key)
	})
	confirmationOpenings.set(key, completed)
	return completed
}

export async function openConfirmTransactionDialogForMessage(...args: Parameters<typeof createConfirmationForMessage>) {
	const [, , request] = args
	return await openPendingConfirmationOnce(request.uniqueRequestIdentifier, async () => await createConfirmationForMessage(...args))
}

export async function openConfirmTransactionDialogForTransaction(...args: Parameters<typeof createConfirmationForTransaction>) {
	const [, , request] = args
	return await openPendingConfirmationOnce(request.uniqueRequestIdentifier, async () => await createConfirmationForTransaction(...args))
}

async function createConfirmationForMessage(
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
	const messageIdentifier = createRequestIdentity(request.uniqueRequestIdentifier)
	const created = new Date()
	const safeMessage = transactionParams.method === 'eth_signTypedData_v4' && confirmation.review !== undefined
		? SafeMessage.parse({ typedData: transactionParams.params[1], review: confirmation.review }) : undefined
	const requestOrigin = getWebsiteSocketRequestOrigin(websiteTabConnections, request.uniqueRequestIdentifier.requestSocket, website.websiteOrigin)
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
		...(requestOrigin === undefined ? {} : { requestOrigin }),
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
		await withPendingConfirmationLock(async (pendingConfirmationLock) => {
			const openedDialog = await getPendingTransactionWindow(ethereumClientService, tokenPriceService, websiteTabConnections, pendingConfirmationLock)
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

// Forms the transaction a confirmation's Gnosis Safe preparation decided on. A preparation failure stands in for the transaction, which is then not formed.
async function formPreparedTransaction(
	ethereumClientService: EthereumClientService,
	safePreparation: SafeTransactionConfirmationPreparation,
	website: Website,
	created: Date,
	transactionIdentifier: bigint,
	simulationMode: boolean,
): Promise<WebsiteCreatedEthereumTransactionOrFailed> {
	const { effectiveTransactionParams, transactionExecutor, gasPayment, preparationMessage } = safePreparation
	if (preparationMessage !== undefined) return {
		website,
		created,
		originalRequestParameters: effectiveTransactionParams,
		transactionIdentifier,
		success: false,
		error: { code: METAMASK_ERROR_FAILED_TO_PARSE_REQUEST, message: preparationMessage },
	}
	if (effectiveTransactionParams.method === 'eth_sendTransaction') return await formEthSendTransaction(
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
	return await formSendRawTransaction(ethereumClientService, effectiveTransactionParams, website, created, transactionIdentifier)
}

// A refresh of a Gnosis Safe proposal whose transaction did not form when its confirmation opened (getPendingTransactionRefresh): prepares the confirmation again as opening it did, which forms the transaction and creates the proposal from it, and returns the flow and approval status to store with it. Returns undefined, keeping the pending transaction as it is, if the request is no longer a proposal of a configured Gnosis Safe. Run it with runWithPendingConfirmationLock, holding the lock until the proposal is stored.
export async function prepareUnformedSafeProposalAgain(
	ethereumClientService: EthereumClientService,
	pending: SimulatedPendingTransaction,
	safeRequestContext: SafeTransactionRequestContext | undefined,
) {
	const tabId = pending.uniqueRequestIdentifier.requestSocket.tabId
	const safePreparation = await prepareSafeTransactionConfirmation(
		ethereumClientService,
		{ kind: 'transaction', parameters: pending.originalRequestParameters, ...(safeRequestContext === undefined ? {} : { safeTransaction: safeRequestContext }) },
		pending.simulationMode,
		pending.activeAddress,
		getWalletSelectedAccount(await getTabState(tabId)),
	)
	if (safePreparation.flowKind !== 'proposal') return undefined
	const formedTransaction = await formPreparedTransaction(ethereumClientService, safePreparation, pending.website, pending.created, pending.transactionIdentifier, pending.simulationMode)
	const { transactionToSimulate, safeFlow, approvalStatus } = await safePreparation.finalize(formedTransaction, tabId)
	return { transactionToSimulate, preparedSafeProposal: { safeFlow, approvalStatus: approvalStatus ?? { status: 'WaitingForUser' as const } } }
}

async function createConfirmationForTransaction(
	ethereumClientService: EthereumClientService,
	tokenPriceService: TokenPriceService,
	request: InterceptedRequest,
	confirmation: TransactionConfirmationRequest,
	simulationMode: boolean,
	activeAddress: bigint | undefined,
	website: Website,
	websiteTabConnections: WebsiteTabConnections,
) {
	const transactionIdentifier = createRequestIdentity(request.uniqueRequestIdentifier)
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
	const { effectiveTransactionParams, transactionExecutor } = safePreparation
	const transactionToSimulatePromise = formPreparedTransaction(ethereumClientService, safePreparation, website, created, transactionIdentifier, simulationMode)
	silenceChromeUnCaughtPromise(transactionToSimulatePromise)
	const outcome = await withPendingConfirmationLock(async (pendingConfirmationLock) => {
		const finalizedSafePreparation = await safePreparation.finalize(
			await transactionToSimulatePromise,
			request.uniqueRequestIdentifier.requestSocket.tabId,
		)
		let storedConfirmation: StoredConfirmation | undefined
		try {
			const { transactionToSimulate, safeFlow, approvalStatus: safeSignerMismatch } = finalizedSafePreparation
			const openedDialog = await getPendingTransactionWindow(ethereumClientService, tokenPriceService, websiteTabConnections, pendingConfirmationLock)
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
				safeFlow,
			}
			await appendPendingTransactionOrMessage(pendingTransaction)
			storedConfirmation = pendingTransaction
			await updateConfirmTransactionView(ethereumClientService, tokenPriceService)
			markPerformance(POPUP_PERFORMANCE_MARKS.backgroundTransactionSimulationStart)
			const simulationStartedTimestamp = new Date()
			const simulationResultsPromise = silenceChromeUnCaughtPromise(refreshConfirmTransactionSimulation(
				ethereumClientService,
				tokenPriceService,
				transactionExecutor,
				simulationMode,
				request.uniqueRequestIdentifier,
				transactionToSimulate,
				getCreatedSafeProposal(safeFlow),
			))
			if (transactionToSimulate.success) {
				await updatePendingTransactionOrMessage(pendingTransaction.uniqueRequestIdentifier, async (transaction) => ({ ...transaction, transactionToSimulate: transactionToSimulate, transactionOrMessageCreationStatus: 'Simulating' as const }))
				await updateConfirmTransactionView(ethereumClientService, tokenPriceService)
			}
			const simulationResult = await simulationResultsPromise
			markPerformance(POPUP_PERFORMANCE_MARKS.backgroundTransactionSimulationEnd)
			// Refreshes skip a confirmation that is still simulating, so a run that ended without a result is stored as a failed simulation, which refreshes simulate again, instead of leaving the confirmation simulating with no run left to finish it.
			const popupVisualisation = simulationResult ?? createInterruptedConfirmTransactionSimulation(transactionExecutor, simulationMode, request.uniqueRequestIdentifier, transactionToSimulate, signerTabState.signerName, simulationStartedTimestamp)
			await updatePendingTransactionOrMessage(pendingTransaction.uniqueRequestIdentifier, async (transaction) => {
				if (transaction.type !== 'Transaction') return transaction
				if (transaction.transactionOrMessageCreationStatus === 'Simulated' || transaction.transactionOrMessageCreationStatus === 'FailedToSimulate') {
					// A result another run stored meanwhile is kept over this run's interruption.
					if (simulationResult === undefined) return transaction
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
			// The requesting page gets this rejection, so a confirmation already stored for the request is removed rather than left for the user to answer a request that is already answered.
			if (storedConfirmation !== undefined) await removeConfirmationOfRejectedRequest(ethereumClientService, tokenPriceService, storedConfirmation, websiteTabConnections, pendingConfirmationLock)
			return formRejectMessage(METAMASK_ERROR_FAILED_TO_PARSE_REQUEST, 'The Interceptor failed to send transaction')
		}
	})
	if (!('success' in outcome)) return formRejectMessage(outcome.error.code, outcome.error.message)
	const pendingTransactionData = await getPendingTransactionOrMessageByidentifier(request.uniqueRequestIdentifier)

	if (pendingTransactionData === undefined) return formRejectMessage(METAMASK_ERROR_BLANKET_ERROR, 'The Interceptor failed to process the transaction')
	return { type: 'doNotReply' as const }
}
