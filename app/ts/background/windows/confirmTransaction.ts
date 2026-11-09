import type { MessageConfirmationRequest, TransactionConfirmationRequest } from '../../types/confirmationRequest.js'
import { SafeMessage } from '../../safe/safeMessage.js'
import { isSafeMessageCoSignRequest } from '../../safe/safeRequestPolicy.js'
import type { EthereumClientService } from '../../simulation/services/EthereumClientService.js'
import { getInputFieldFromDataOrInput, getSimulatedBalance, getSimulatedErc20Balance, getSimulatedTransactionCount, simulateEstimateGas } from '../../simulation/services/SimulationModeEthereumClientService.js'
import { simulatePersonalSign } from '../../simulation/services/simulationPersonalSigning.js'
import { getSignedTransactionForSimulation } from '../../simulation/services/simulationTransactionSigning.js'
import { CANNOT_SIMULATE_OFF_LEGACY_BLOCK, ERROR_INTERCEPTOR_NO_ACTIVE_ADDRESS, METAMASK_ERROR_BLANKET_ERROR, METAMASK_ERROR_FAILED_TO_PARSE_REQUEST } from '../../utils/constants.js'
import { type TransactionConfirmation, UpdateConfirmTransactionDialog, UpdateConfirmTransactionDialogPendingTransactions } from '../../types/interceptor-messages.js'
import { createScopedKeyedSerialExecutor, Semaphore } from '../../utils/semaphore.js'
import type { WebsiteTabConnections } from '../../types/user-interface-types.js'
import { type InterceptorTransactionStack, PASSTHROUGH_STATE, type TransactionGasPayment, type TransactionSimulationOptions, type WebsiteCreatedEthereumTransaction, type WebsiteCreatedEthereumTransactionOrFailed, createPassthroughCompleteVisualizedSimulation } from '../../types/visualizer-types.js'
import type { SendRawTransactionParams, SendTransactionParams } from '../../types/JsonRpc-types.js'
import { refreshConfirmTransactionSimulation, reserveConfirmationRun } from '../confirmTransactionSimulation.js'
import { getConfirmationRunInputs, mayStoreNewRun } from '../confirmationRun.js'
import { captureSimulationSnapshot, getExecutedCallFormation, getUpdatedSimulationState } from '../simulationUpdating.js'
import { getHtmlFile, sendPopupMessageToOpenWindows } from '../backgroundUtils.js'
import { appendPendingTransactionOrMessage, getInterceptorTransactionStack, getPendingTransactionsAndMessages, getRpcConnectionStatus, getTabState, getUserAddressBookEntriesForChainIdMorePreciseFirst, publishPendingTransactionsAndMessages, removePendingTransactionOrMessage, updateInterceptorTransactionStack, updatePendingTransactionOrMessage } from '../storageVariables.js'
import { type InterceptedRequest, type UniqueRequestIdentifier, getUniqueRequestIdentifierString, silenceChromeUnCaughtPromise } from '../../utils/requests.js'
import { replyToInterceptedRequestAfterManifestV2Reconnect } from '../messageSending.js'
import { forwardToSignerOnRequestedNetwork } from '../requestedNetworkForwarding.js'
import { cancelPendingTransactionOrMessage, commitIfStillPending, createTerminalReply, formRejectMessage, getPendingTransactionOrMessageByidentifier, queueTerminalReplyAndRemovePendingRequest, type TerminalReplyContent } from '../pendingRequestCommits.js'
import { attemptQueuedTerminalReplyDelivery } from '../terminalReplyDelivery.js'
import { stringToBytes, keccak256 } from '../../utils/ethereumPrimitives.js'
import { EthereumBytes32, EthereumQuantity, serialize } from '../../types/wire-types.js'
import type { PopupOrTabId, Website } from '../../types/websiteAccessTypes.js'
import { getErrorMessage, JsonRpcResponseError, reportUnexpectedError, isExpectedInfrastructureError, isNewBlockAbort, reportLocalRecovery } from '../../utils/errors.js'
import type { ConfirmationRunId, PendingTransactionOrSignableMessage } from '../../types/accessRequest.js'
import { toPopupPendingTransactionOrSignableMessage } from '../../utils/popupPendingRequest.js'
import type { SignMessageParams } from '../../types/jsonRpc-signing-types.js'
import type { InterceptedRequestForward } from '../../types/interceptor-messages.js'
import type { SimulationStackChange } from '../../types/visualizer-types.js'
import type { SafeSignerErrorDetails } from '../../types/safeTypes.js'
import { craftPersonalSignPopupMessage } from './personalSign.js'
import { getSettings } from '../settings.js'
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
import { persistUnsignedSafeTransaction, resolveSafeSignerReply, type SafeResolutionCommit } from '../safeConfirmationPersistence.js'
import { getWalletSelectedAccount } from '../../utils/activeAddressSelection.js'
import { createSafeSignerErrorStatus } from '../safeSignerErrors.js'
import type { SimulationServices } from '../../simulation/serviceLifecycle.js'
import { getTransactionNetworkApprovalError, isEthereumClientOnTransactionChain, readNetworkRefusalMessages, updateInterceptorTransactionStackOnRequestedNetwork } from '../transactionNetwork.js'

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

// The rebuild runs as the confirmation run that its entry reserved before its first await, so it is ordered by when that entry started.
async function refreshDirectSafeExecutionSimulation(
	confirmationRun: ConfirmationRunId,
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
		confirmationRun,
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
	// Reserved before anything is awaited, so the Gnosis Safe rebuilds below are ordered from when this refresh started. They run one after another, so they share it.
	const confirmationRun = reserveConfirmationRun()
	const tabState = await getTabState(tabId)
	const refreshedSelection = {
		selectedSigner: getWalletSelectedAccount(tabState),
		verificationError: undefined,
	}
	let pendingStateChanged = false
	for (const pending of await getPendingTransactionsAndMessages()) {
		const safeSignerAddress = getPendingSafeSignerAddress(pending)
		if (pending.uniqueRequestIdentifier.requestSocket.tabId !== tabId) continue
		// Rebuilding a Gnosis Safe proposal or execution signs for and simulates on the client's network, so a transaction is only rebuilt with the client of the network it was requested on.
		const rebuildsOnRequestedNetwork = pending.type !== 'Transaction' || isEthereumClientOnTransactionChain(ethereum, pending)
		if (refreshedSelection.selectedSigner !== undefined && rebuildsOnRequestedNetwork) {
			const refresh = await refreshAndPersistSafeSignerSelection(
				ethereum,
				pending,
				refreshedSelection.selectedSigner,
				async (refreshedPending) => await refreshDirectSafeExecutionSimulation(confirmationRun, ethereum, tokenPriceService, refreshedPending),
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


type ShowPending = (pending: readonly PendingTransactionOrSignableMessage[]) => readonly PendingTransactionOrSignableMessage[]

// Sends the confirmation window the queue as it is stored at this moment, the window's only source of it, and with a view also the simulation view and the block data, which come after the queue. A push must never be older than the moment it is sent, or it could undo a later change, such as an approval handed to the signer, after the window has shown that change. So the stored confirmations are read here, under the lock of their writers, in the same step as the send, and a caller with slow work sends the queue only after it. The refusals shown with the queue are derived here from the stored active network and the given client, and showPending adds what a caller has prepared but not stored.
export async function publishConfirmationView(ethereum: EthereumClientService, view: UpdateConfirmTransactionDialog['data'] | undefined, showPending: ShowPending = (pending) => pending) {
	const getNetworkRefusalMessage = await readNetworkRefusalMessages(ethereum)
	return await publishPendingTransactionsAndMessages((pending) => {
		if (pending.length === 0) return []
		const messagePendingTransactions: UpdateConfirmTransactionDialogPendingTransactions = {
			method: 'popup_update_confirm_transaction_dialog_pending_transactions' as const,
			data: { pendingTransactionAndSignableMessages: showPending(pending).map((current) => toPopupPendingTransactionOrSignableMessage(current, getNetworkRefusalMessage)) },
		}
		const queueMessage = serialize(UpdateConfirmTransactionDialogPendingTransactions, messagePendingTransactions)
		if (view === undefined) return [queueMessage]
		const message: UpdateConfirmTransactionDialog = { method: 'popup_update_confirm_transaction_dialog', data: view }
		return [queueMessage, serialize(UpdateConfirmTransactionDialog, message)]
	}, async (message) => await sendPopupMessageToOpenWindows(message, 'confirmTransaction'))
}

// Sends the confirmation window the stored queue, which needs no RPC. It is sent after every stored change, before anything else happens, such as the wallet being prompted, and whenever the window asks for it, as it does when it opens and when the network, the client or the settings change.
export const publishConfirmationQueue = async (ethereum: EthereumClientService) => await publishConfirmationView(ethereum, undefined)

// Sends the simulation view and the block data, without the queue: they wait for an RPC, and a client that was replaced meanwhile would derive refusals the installed one no longer gives, so the queue goes out before the slow work instead.
async function publishSimulationView(view: UpdateConfirmTransactionDialog['data']) {
	const message: UpdateConfirmTransactionDialog = { method: 'popup_update_confirm_transaction_dialog', data: view }
	await sendPopupMessageToOpenWindows(serialize(UpdateConfirmTransactionDialog, message), 'confirmTransaction')
}

// Sends the simulation view with the block data, which waits for an RPC. It tells whether it was sent.
async function updateConfirmationSimulationView(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, onlyIfNotAlreadyUpdating: boolean) {
	const currentBlockNumberPromise = silenceChromeUnCaughtPromise(ethereum.getBlockNumber(undefined))
	const rpcConnectionStatusPromise = silenceChromeUnCaughtPromise(getRpcConnectionStatus())
	const settings = await getSettings()
	const visualizedSimulatorState = settings.simulationMode
		? await updatePopupVisualisationIfNeeded(ethereum, tokenPriceService, { onlyIfNotAlreadyUpdating })
		: createPassthroughCompleteVisualizedSimulation()
	await publishSimulationView({ currentBlockNumber: await currentBlockNumberPromise, rpcConnectionStatus: await rpcConnectionStatusPromise, visualizedSimulatorState })
}

// Reports a failed window update, unless the RPC or the browser failed as they can at any time. It tells whether the update was sent, never.
async function reportFailedWindowUpdate(error: unknown) {
	if (!isExpectedInfrastructureError(error)) await reportUnexpectedError(error)
	return false
}

// Tells the windows what is stored: the queue at once, then the simulation view once its RPC answers. It only reads: a stored status is changed by the code that owns it, never as a side effect of showing it. It tells whether a queue was shown.
export async function updateConfirmTransactionView(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, onlyIfNotAlreadyUpdating = false) {
	try {
		if (!await publishConfirmationQueue(ethereum)) return false
		await updateConfirmationSimulationView(ethereum, tokenPriceService, onlyIfNotAlreadyUpdating)
		return true
	} catch(error: unknown) {
		return await reportFailedWindowUpdate(error)
	}
}

export const isConfirmTransactionFocused = async () => {
	const pendingTransactions = await getPendingTransactionsAndMessages()
	if (pendingTransactions[0] === undefined) return false
	const popup = await getPopupOrTabById(pendingTransactions[0].popupOrTabId)
	if (popup === undefined) return false
	if (popup.type === 'popup') return popup.window.focused
	return popup.tab.active
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
		// The approved request was already forwarded with its gas limit, so it is only changed again once the signer hands the request back.
		if (transaction.approvalStatus.status === 'WaitingForSigner') return transaction
		if (transaction.originalRequestParameters.method === 'eth_sendTransaction') {
			const originalRequestParameters = modifyObject(transaction.originalRequestParameters, { params: [modifyObject(transaction.originalRequestParameters.params[0], { gas: gasLimit })] })
			return modifyObject(transaction, { originalRequestParameters: originalRequestParameters })
		}
		return transaction
	})
}

// A request has two locks: the resolution lock keeps its approvals and signer replies one at a time, and the short commit lock of commitIfStillPending orders their final commits against a rejection. A rejection or a closed window takes only the commit lock, so it bypasses preparation, and nothing here holds that lock. A resolution still awaits no RPC to update the window, as a queued approval or signer reply would wait for it under the resolution lock. The window is sent the stored queue, which needs no RPC and reaches it before anything the resolution does next, such as prompting the wallet. The view update, which does need an RPC, is started without being awaited, which keeps the reply to the approval prompt: that reply is what enables the reject button again.
async function showStoredStateAndRefreshView(ethereum: EthereumClientService, tokenPriceService: TokenPriceService) {
	await publishConfirmationQueue(ethereum)
	silenceChromeUnCaughtPromise(updateConfirmationSimulationView(ethereum, tokenPriceService, false).catch(reportFailedWindowUpdate))
}

// A refused approval stores no refusal: the window derives it from the network and the installed client whenever the queue is sent, so it is shown with the queue sent here and lifts on the push after the network or the client changes back. A request the approval handed to the signer, whose posting the refusal stopped, goes back to the user.
async function showNetworkRefusal(getInstalledServices: GetInstalledServices, uniqueRequestIdentifier: UniqueRequestIdentifier) {
	await updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (pending) => pending.approvalStatus.status === 'WaitingForSigner' ? modifyObject(pending, { approvalStatus: { status: 'WaitingForUser' as const } }) : undefined)
	const { ethereum, tokenPriceService } = getInstalledServices()
	await showStoredStateAndRefreshView(ethereum, tokenPriceService)
	return false
}

// Updates the confirmation window once the request has left the confirmation queue: the view of how the simulation stack changed, and the queue view, which focuses the website's tab once the queue is empty and closes the window once no pending request is shown in it. The website's answer never waits for this view work, so a failure in it is reported instead of reaching the caller.
async function updateViewAfterPendingRequestRemoved(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, removedRequest: PendingTransactionOrSignableMessage, simulationStack: SimulationStackChange) {
	const removedRequestWindow = removedRequest.popupOrTabId
	await runConfirmationViewStep(async () => await publishConfirmationQueue(ethereum))
	await runConfirmationViewStep(async () => await showSimulationStackChange(ethereum, tokenPriceService, simulationStack))
	await runConfirmationViewStep(async () => {
		if ((await getPendingTransactionsAndMessages()).length === 0) await tryFocusingTabOrWindow({ type: 'tab', id: removedRequest.uniqueRequestIdentifier.requestSocket.tabId })
	})
	await runConfirmationViewStep(async () => {
		const confirmationQueueIsShown = await updateConfirmTransactionView(ethereum, tokenPriceService)
		// The website may send its next request as soon as it has this answer. Arriving while the queue is empty, that request opens a window of its own, so this window is closed once no pending request is shown in it rather than only once the queue is empty.
		const windowShowsAPendingRequest = (await getPendingTransactionsAndMessages()).some((pending) => pending.popupOrTabId.type === removedRequestWindow.type && pending.popupOrTabId.id === removedRequestWindow.id)
		if (!confirmationQueueIsShown || !windowShowsAPendingRequest) await closePopupOrTabById(removedRequestWindow)
	})
}

type GetInstalledServices = () => Pick<SimulationServices, 'ethereum' | 'tokenPriceService'>

const pendingTransactionOrMessageResolutionScope = {}
const serializePendingTransactionOrMessageResolution = createScopedKeyedSerialExecutor<typeof pendingTransactionOrMessageResolutionScope, string>()

// Approvals and signer replies of one request can overlap, for example when duplicate confirmation windows both approve it or a double click sends two approvals. They run one at a time under this resolution lock on freshly read state, so a later approval sees that the first one already forwarded the request to the signer, or added it to the simulation stack and removed it.
async function resolvePendingTransactionOrMessageSerially<T>(uniqueRequestIdentifier: UniqueRequestIdentifier, resolve: (pendingTransactionOrMessage: PendingTransactionOrSignableMessage) => Promise<T>) {
	return await serializePendingTransactionOrMessageResolution(pendingTransactionOrMessageResolutionScope, getUniqueRequestIdentifierString(uniqueRequestIdentifier), async () => {
		const pendingTransactionOrMessage = await getPendingTransactionOrMessageByidentifier(uniqueRequestIdentifier)
		if (pendingTransactionOrMessage === undefined) return undefined // no need to resolve as it doesn't exist anymore
		return await resolve(pendingTransactionOrMessage)
	})
}

// A wallet-confirmed Gnosis Safe signer selection, with the confirmation run reserved for the rebuild it may need.
type SafeSignerRefreshAtApproval = { readonly selection: RefreshedSafeSignerSelection, readonly confirmationRun: ConfirmationRunId }

// What a resolution is given besides the services it prepares and checks with, which are the ethereum and tokenPriceService passed before it. getInstalledServices reads the services installed at the moment a refusal is shown, which can differ from those when a resolution outlives a network switch.
export type ResolutionOptions = {
	readonly refreshedSafeSignerSelection?: RefreshedSafeSignerSelection
	readonly safeRebuildRun?: ConfirmationRunId
	readonly getInstalledServices?: GetInstalledServices
}

// Forwarding to the signer only posts the request, so neither lock is held while the user decides in the wallet. The signer's reply is resolved later as a separate signerIncluded resolution. A caller that refreshed the Gnosis Safe signer selection before calling passes the run it reserved when it started, as confirmDialog does; otherwise the run is reserved here, before anything is awaited.
export async function resolvePendingTransactionOrMessage(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, websiteTabConnections: WebsiteTabConnections, confirmation: TransactionConfirmation, { refreshedSafeSignerSelection, safeRebuildRun, getInstalledServices = () => ({ ethereum, tokenPriceService }) }: ResolutionOptions = {}) {
	const safeSignerRefresh = refreshedSafeSignerSelection === undefined ? undefined : { selection: refreshedSafeSignerSelection, confirmationRun: safeRebuildRun ?? reserveConfirmationRun() }
	// The window work after a request leaves the queue needs an RPC, so it runs once the resolution lock is released.
	const stepsAfterResolution: (() => Promise<void>)[] = []
	try {
		if (confirmation.data.action === 'reject' || confirmation.data.action === 'noResponse') return await cancelPendingTransactionOrMessage(websiteTabConnections, confirmation.data.uniqueRequestIdentifier, confirmation.data.action, (removed) => stepsAfterResolution.push(async () => await updateViewAfterPendingRequestRemoved(ethereum, tokenPriceService, removed, 'unchanged')))
		return await resolvePendingTransactionOrMessageSerially(confirmation.data.uniqueRequestIdentifier, async (storedPendingTransactionOrMessage) => await resolveStoredPendingTransactionOrMessage(ethereum, tokenPriceService, websiteTabConnections, confirmation, storedPendingTransactionOrMessage, getInstalledServices, stepsAfterResolution, safeSignerRefresh))
	} finally {
		for (const step of stepsAfterResolution) await step()
	}
}

const isAwaitingSignerReply = (pending: PendingTransactionOrSignableMessage) => pending.approvalStatus.status === 'WaitingForSigner'

async function resolveStoredPendingTransactionOrMessage(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, websiteTabConnections: WebsiteTabConnections, confirmation: TransactionConfirmation, storedPendingTransactionOrMessage: PendingTransactionOrSignableMessage, getInstalledServices: GetInstalledServices, stepsAfterResolution: (() => Promise<void>)[], safeSignerRefresh?: SafeSignerRefreshAtApproval) {
	let pendingTransactionOrMessage = storedPendingTransactionOrMessage
	// A signer reply only completes a request that was forwarded to the signer, so a reply for a request no signer was asked about, such as one still awaiting the user's approval, changes nothing; the commits below check this again on the stored request.
	if (confirmation.data.action === 'signerIncluded' && !isAwaitingSignerReply(pendingTransactionOrMessage)) return false
	if (confirmation.data.action === 'accept' || confirmation.data.action === 'addToSafeStack') {
		// A request that was already forwarded can only be completed by the signer's reply, so it is not approved or added to a Gnosis Safe stack again.
		if (pendingTransactionOrMessage.approvalStatus.status === 'WaitingForSigner') return false
		// Checked before the Gnosis Safe refresh below, which rebuilds the transaction with this client, and before a proposal is stored in this client's Gnosis Safe stack.
		const networkApprovalError = pendingTransactionOrMessage.type === 'Transaction' ? await getTransactionNetworkApprovalError(ethereum, pendingTransactionOrMessage) : undefined
		if (networkApprovalError !== undefined) return await showNetworkRefusal(getInstalledServices, confirmation.data.uniqueRequestIdentifier)
	}
	if (
		confirmation.data.action === 'accept'
		&& safeSignerRefresh?.selection.selectedSigner !== undefined
		&& safeSignerRefresh.selection.verificationError === undefined
	) {
		const directSafeExecution = getSafePendingFlow(pendingTransactionOrMessage)?.kind === 'directExecution'
		const refresh = await refreshAndPersistSafeSignerSelection(
			ethereum,
			pendingTransactionOrMessage,
			safeSignerRefresh.selection.selectedSigner,
			async (refreshedPending) => await refreshDirectSafeExecutionSimulation(safeSignerRefresh.confirmationRun, ethereum, tokenPriceService, refreshedPending),
		)
		const refreshResult = refresh.refreshResult
		if (refresh.refreshRequired && refreshResult.status !== 'unchanged' && !refresh.persisted) {
			await showStoredStateAndRefreshView(ethereum, tokenPriceService)
			return false
		}
		if (refresh.refreshRequired && (refreshResult.status === 'blocked' || directSafeExecution && refreshResult.status === 'refreshed')) {
			await showStoredStateAndRefreshView(ethereum, tokenPriceService)
			return false
		}
		if (refresh.persistedPending !== undefined) pendingTransactionOrMessage = refresh.persistedPending
	}
	const safeResolution = await resolveSafeConfirmation(
		ethereum,
		pendingTransactionOrMessage,
		confirmation.data.action,
		safeSignerRefresh?.selection,
	)
	if (safeResolution.status === 'blocked') {
		await updatePendingTransactionOrMessage(confirmation.data.uniqueRequestIdentifier, async (pending) => modifyObject(pending, {
			approvalStatus: safeResolution.approvalStatus,
		}))
		await showStoredStateAndRefreshView(ethereum, tokenPriceService)
		return false
	}
	if (safeResolution.status === 'refreshed') {
		pendingTransactionOrMessage = safeResolution.pending
		await updatePendingTransactionOrMessage(confirmation.data.uniqueRequestIdentifier, async () => pendingTransactionOrMessage)
		await showStoredStateAndRefreshView(ethereum, tokenPriceService)
		return false
	}
	pendingTransactionOrMessage = safeResolution.pending
	if (safeResolution.pendingChanged) {
		await updatePendingTransactionOrMessage(confirmation.data.uniqueRequestIdentifier, async () => pendingTransactionOrMessage)
	}
	const signerFacingRequest: SendTransactionParams | SendRawTransactionParams | SignMessageParams = safeResolution.signerFacingRequest
		?? pendingTransactionOrMessage.originalRequestParameters
	const uniqueRequestIdentifier = confirmation.data.uniqueRequestIdentifier
	const afterPendingRequestRemoved = (simulationStack: SimulationStackChange) => stepsAfterResolution.push(async () => await updateViewAfterPendingRequestRemoved(ethereum, tokenPriceService, pendingTransactionOrMessage, simulationStack))
	const removePendingRequestAndUpdateView = async () => {
		await removePendingTransactionOrMessage(uniqueRequestIdentifier)
		afterPendingRequestRemoved('unchanged')
	}
	// The window is updated after the resolution even when delivery throws, and the delivery error reaches the caller once it is.
	const commitTerminalReply = async (terminalReply: InterceptedRequestForward, simulationStack: SimulationStackChange) => {
		await queueTerminalReplyAndRemovePendingRequest(terminalReply, uniqueRequestIdentifier)
		afterPendingRequestRemoved(simulationStack)
	}
	const deliverTerminalReply = async (terminalReply: InterceptedRequestForward) => await attemptQueuedTerminalReplyDelivery(websiteTabConnections, terminalReply)
	const mayCommitThisResolution = (stored: PendingTransactionOrSignableMessage) => confirmation.data.action !== 'signerIncluded' || isAwaitingSignerReply(stored)
	const reply = async (content: TerminalReplyContent, simulationStack: SimulationStackChange = 'unchanged') => {
		const terminalReply = createTerminalReply(pendingTransactionOrMessage, uniqueRequestIdentifier, content)
		const committed = await commitIfStillPending(uniqueRequestIdentifier, async () => await commitTerminalReply(terminalReply, simulationStack), mayCommitThisResolution)
		return committed.stored ? await deliverTerminalReply(terminalReply) : false
	}
	// The stored proposal and the reply to it are one commit, so a rejection cannot arrive between them.
	const commitSafeResolution: SafeResolutionCommit = async (write) => {
		const committed = await commitIfStillPending(uniqueRequestIdentifier, async () => {
			const resolution = await write()
			if (resolution.status === 'success') await commitTerminalReply(createTerminalReply(pendingTransactionOrMessage, uniqueRequestIdentifier, { type: 'result', result: resolution.result }), resolution.simulationStack)
			return resolution
		}, mayCommitThisResolution)
		return committed.stored ? committed.result : { status: 'cancelled' }
	}
	const deliverCommittedSafeResolution = async (result: string) => await deliverTerminalReply(createTerminalReply(pendingTransactionOrMessage, uniqueRequestIdentifier, { type: 'result', result }))
	if (confirmation.data.action === 'addToSafeStack') {
		if (pendingTransactionOrMessage.approvalStatus.status === 'WaitingForSigner') return false
		const safeReply = await persistUnsignedSafeTransaction(ethereum, pendingTransactionOrMessage, commitSafeResolution)
		if (safeReply.status === 'cancelled') return false
		if (safeReply.status === 'networkRefusal') return await showNetworkRefusal(getInstalledServices, confirmation.data.uniqueRequestIdentifier)
		if (safeReply.status === 'error') {
			await updatePendingTransactionOrMessage(confirmation.data.uniqueRequestIdentifier, async (pending) => modifyObject(pending, {
				approvalStatus: safeReply.approvalStatus,
			}))
			await showStoredStateAndRefreshView(ethereum, tokenPriceService)
			return false
		}
		if (safeReply.status === 'success') return await deliverCommittedSafeResolution(safeReply.result)
		return false
	}
	// Refuses an accept for any request whose latest run is not Simulated, still crafting, simulating or failed, so only a preview the Interceptor produced is approved; this also keeps the raw-transaction chain check, which the requested-network rule applies to a Simulated preview, on this path.
	if (
		confirmation.data.action === 'accept'
		&& pendingTransactionOrMessage.transactionOrMessageCreationStatus !== 'Simulated'
	) return false
	if (confirmation.data.action === 'accept' && pendingTransactionOrMessage.simulationMode === false) {
		const waitingForSigner = await commitIfStillPending(uniqueRequestIdentifier, async () => await updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (transaction) => modifyObject(transaction, { approvalStatus: { status: 'WaitingForSigner' } })))
		if (!waitingForSigner.stored) return false
		await showStoredStateAndRefreshView(ethereum, tokenPriceService)
		// The forwarded parameters carry no chain id, so the network is checked once more right before every attempt to post the request to the wallet.
		const forwarding = await forwardToSignerOnRequestedNetwork(websiteTabConnections, ethereum, pendingTransactionOrMessage, { ...signerFacingRequest, type: 'forwardToSigner', uniqueRequestIdentifier: confirmation.data.uniqueRequestIdentifier }, async (commit) => await commitIfStillPending(uniqueRequestIdentifier, commit))
		if (!forwarding.committed) return await showNetworkRefusal(getInstalledServices, confirmation.data.uniqueRequestIdentifier)
		if (forwarding.result) return true
		await updatePendingTransactionOrMessage(confirmation.data.uniqueRequestIdentifier, async (transaction) => modifyObject(transaction, {
			approvalStatus: {
				status: 'SignerError',
				code: METAMASK_ERROR_BLANKET_ERROR,
				message: 'The website connection was interrupted before the request reached your wallet. Reload the website and try again.',
			}
		}))
		await showStoredStateAndRefreshView(ethereum, tokenPriceService)
		return false
	}
	if (pendingTransactionOrMessage === undefined || pendingTransactionOrMessage.transactionOrMessageCreationStatus !== 'Simulated') return await reply(formRejectMessage(METAMASK_ERROR_BLANKET_ERROR, 'The Interceptor failed to process the transaction'))
	if (!pendingTransactionOrMessage.simulationMode) {
		if (confirmation.data.action === 'signerIncluded') {
			const safeReply = await resolveSafeSignerReply(ethereum, pendingTransactionOrMessage, confirmation.data.signerReply, commitSafeResolution)
			if (safeReply.status === 'cancelled') return false
			if (safeReply.status === 'networkRefusal') return await showNetworkRefusal(getInstalledServices, confirmation.data.uniqueRequestIdentifier)
			if (safeReply.status === 'error') {
				await updatePendingTransactionOrMessage(confirmation.data.uniqueRequestIdentifier, async (pending) => modifyObject(pending, {
					approvalStatus: safeReply.approvalStatus,
				}))
				await showStoredStateAndRefreshView(ethereum, tokenPriceService)
				return false
			}
			if (safeReply.status === 'success') return await deliverCommittedSafeResolution(safeReply.result)
			return await reply({ type: 'result', result: confirmation.data.signerReply })
		}
		await removePendingRequestAndUpdateView()
		return await replyToInterceptedRequestAfterManifestV2Reconnect(websiteTabConnections, { ...signerFacingRequest, type: 'forwardToSigner', uniqueRequestIdentifier: confirmation.data.uniqueRequestIdentifier })
	}
	if (confirmation.data.action === 'signerIncluded') throw new Error('Signer included transaction that was in simulation')

	switch (pendingTransactionOrMessage.type) {
		case 'SignableMessage': {
			const { signedMessageTransaction } = pendingTransactionOrMessage
			const { signature } = await simulatePersonalSign(pendingTransactionOrMessage.originalRequestParameters, signedMessageTransaction.fakeSignedFor)
			const terminalReply = createTerminalReply(pendingTransactionOrMessage, uniqueRequestIdentifier, { type: 'result', result: signature })
			const committed = await commitIfStillPending(uniqueRequestIdentifier, async () => {
				await updateInterceptorTransactionStack((prevStack: InterceptorTransactionStack) => ({ operations: [
					...prevStack.operations,
					{ type: 'Message' as const, signedMessageTransaction }
				] }))
				await commitTerminalReply(terminalReply, 'changed')
			})
			return committed.stored ? await deliverTerminalReply(terminalReply) : false
		}
		case 'Transaction': {
			const signedTransaction = getSignedTransactionForSimulation(pendingTransactionOrMessage.transactionToSimulate)
			const transaction = { ...pendingTransactionOrMessage.transactionToSimulate, signedTransaction }
			const terminalReply = createTerminalReply(pendingTransactionOrMessage, uniqueRequestIdentifier, { type: 'result', result: EthereumBytes32.serialize(signedTransaction.hash) })
			const committed = await commitIfStillPending(uniqueRequestIdentifier, async () => {
				// The stack update is queued right after the final network check, so the stack reset of a later network switch is queued after this transaction is added.
				const addition = await updateInterceptorTransactionStackOnRequestedNetwork(ethereum, pendingTransactionOrMessage, (prevStack: InterceptorTransactionStack) => ({ operations: [
					...prevStack.operations,
					{ type: 'Transaction' as const, preSimulationTransaction: transaction}
				] }))
				if (addition.committed) await commitTerminalReply(terminalReply, 'changed')
				return addition
			})
			if (!committed.stored) return false
			if (!committed.result.committed) return await showNetworkRefusal(getInstalledServices, uniqueRequestIdentifier)
			markPerformance(POPUP_PERFORMANCE_MARKS.backgroundTransactionStackAppended)
			return await deliverTerminalReply(terminalReply)
		}
		default: assertNever(pendingTransactionOrMessage)
	}
}

export const onCloseWindowOrTab = async (popupOrTabs: PopupOrTabId, ethereum: EthereumClientService, tokenPriceService: TokenPriceService, websiteTabConnections: WebsiteTabConnections) => { // check if user has closed the window on their own, if so, reject all signatures
	const transactions = await getPendingTransactionsAndMessages()
	const [firstTransaction] = transactions
	if (firstTransaction === undefined || firstTransaction?.popupOrTabId.type !== popupOrTabs.type || firstTransaction.popupOrTabId.id !== popupOrTabs.id) return
	await resolveAllPendingTransactionsAndMessageAsNoResponse(transactions, ethereum, tokenPriceService, websiteTabConnections)
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
	await resolveAllPendingTransactionsAndMessageAsNoResponse(orphanedTransactions, ethereum, tokenPriceService, websiteTabConnections)
}

const resolveAllPendingTransactionsAndMessageAsNoResponse = async (transactions: readonly PendingTransactionOrSignableMessage[], ethereum: EthereumClientService, tokenPriceService: TokenPriceService, websiteTabConnections: WebsiteTabConnections) => {
	// One at a time, as they can share a reconnecting website, but the window work, which needs an RPC, waits until every website has its answer.
	const stepsAfterRejections: (() => Promise<void>)[] = []
	for (const transaction of transactions) {
		try {
			await cancelPendingTransactionOrMessage(websiteTabConnections, transaction.uniqueRequestIdentifier, 'noResponse', (removed) => stepsAfterRejections.push(async () => await updateViewAfterPendingRequestRemoved(ethereum, tokenPriceService, removed, 'unchanged')))
		} catch(e) {
			await reportLocalRecovery(e, { code: 'pending_request_no_response_resolution_failed', message: 'Failed to resolve a pending request as no-response after a popup closed.' })
			schedulePendingNoResponseRetry(transaction, ethereum, tokenPriceService, websiteTabConnections)
		}
	}
	for (const step of stepsAfterRejections) await step()
}

function schedulePendingNoResponseRetry(transaction: PendingTransactionOrSignableMessage, ethereum: EthereumClientService, tokenPriceService: TokenPriceService, websiteTabConnections: WebsiteTabConnections) {
	const identifier = getUniqueRequestIdentifierString(transaction.uniqueRequestIdentifier)
	if (pendingNoResponseRetryTimers.has(identifier)) return
	const retryTimer = setTimeout(() => {
		pendingNoResponseRetryTimers.delete(identifier)
		void (async () => {
			try {
				await resolvePendingTransactionOrMessage(ethereum, tokenPriceService, websiteTabConnections, { method: 'popup_confirmDialog', data: { uniqueRequestIdentifier: transaction.uniqueRequestIdentifier, action: 'noResponse' } })
			} catch (error) {
				await reportLocalRecovery(error, { code: 'pending_request_no_response_retry_failed', message: 'Retrying a pending popup-close rejection after a transient failure.' })
				schedulePendingNoResponseRetry(transaction, ethereum, tokenPriceService, websiteTabConnections)
			}
		})()
	}, NO_RESPONSE_RETRY_DELAY_MS)
	pendingNoResponseRetryTimers.set(identifier, retryTimer)
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
	const [firstPendingTransaction] = pendingTransactions
	if (firstPendingTransaction !== undefined) {
		const alreadyOpenWindow = await getPopupOrTabById(firstPendingTransaction.popupOrTabId)
		if (alreadyOpenWindow) return alreadyOpenWindow
		await resolveAllPendingTransactionsAndMessageAsNoResponse(pendingTransactions, ethereum, tokenPriceService, websiteTabConnections)
	}
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
	// Reserved before anything is awaited, so the first simulation of this request is ordered before any refresh requested after it.
	const confirmationRun = reserveConfirmationRun()
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
				requestedChainId: ethereumClientService.getChainId(),
				website,
				approvalStatus: safeSignerMismatch ?? { status: 'WaitingForUser' as const },
				...(safeTransaction === undefined ? {} : { safeTransaction }),
				...(pendingSafeFields ?? {}),
			}
			// The inputs this run prepares the transaction from, so the run is not stored onto a transaction whose gas limit or Gnosis Safe signer changed while it ran.
			const runInputs = getConfirmationRunInputs(pendingTransaction)
			await appendPendingTransactionOrMessage(pendingTransaction)
			await updateConfirmTransactionView(ethereumClientService, tokenPriceService)
			markPerformance(POPUP_PERFORMANCE_MARKS.backgroundTransactionSimulationStart)
			const simulationResultsPromise = silenceChromeUnCaughtPromise(refreshConfirmTransactionSimulation(
				confirmationRun,
				ethereumClientService,
				tokenPriceService,
				transactionExecutor,
				simulationMode,
				request.uniqueRequestIdentifier,
				transactionToSimulate,
				safeTransaction,
			))
			if (transactionToSimulate.success) {
				await updatePendingTransactionOrMessage(pendingTransaction.uniqueRequestIdentifier, async (transaction) => {
					// A refresh may already have stored a preview, or the inputs may have changed, in which case this run's transaction is not shown.
					if (transaction.type !== 'Transaction' || transaction.transactionOrMessageCreationStatus !== 'Crafting' || getConfirmationRunInputs(transaction) !== runInputs) return transaction
					return { ...transaction, transactionToSimulate, transactionOrMessageCreationStatus: 'Simulating' as const }
				})
				await updateConfirmTransactionView(ethereumClientService, tokenPriceService)
			}
			const popupVisualisation = await simulationResultsPromise
			markPerformance(POPUP_PERFORMANCE_MARKS.backgroundTransactionSimulationEnd)
			await updatePendingTransactionOrMessage(pendingTransaction.uniqueRequestIdentifier, async (transaction) => {
				if (transaction.type !== 'Transaction') return transaction
				if (popupVisualisation === undefined) return transaction
				// A run that is not stored leaves the transaction to the next refresh, which simulates it from its stored inputs.
				if (!mayStoreNewRun(transaction, runInputs, popupVisualisation)) return transaction
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
