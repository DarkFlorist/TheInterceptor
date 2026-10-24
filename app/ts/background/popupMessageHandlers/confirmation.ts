import { getSafePendingFlow } from '../../safe/safePendingFlow.js'
import type { EthereumClientService } from '../../simulation/services/EthereumClientService.js'
import type { TokenPriceService } from '../../simulation/services/priceEstimator.js'
import type { SimulationServicesOwner } from '../../simulation/serviceLifecycle.js'
import type { ConfirmTransactionTransactionSingleVisualization, PendingTransactionOrSignableMessage } from '../../types/accessRequest.js'
import type { ChainChangeConfirmation, PopupReadyAndListeningPage, RequestAccountsFromSigner, TransactionConfirmation, WatchAssetConfirmation } from '../../types/interceptor-messages.js'
import type { WebsiteTabConnections } from '../../types/user-interface-types.js'
import { createPassthroughCompleteVisualizedSimulation } from '../../types/visualizer-types.js'
import type { PopupOrTabId } from '../../types/websiteAccessTypes.js'
import { isExpectedInfrastructureError } from '../../utils/errors.js'
import { doesUniqueRequestIdentifiersMatch, silenceChromeUnCaughtPromise } from '../../utils/requests.js'
import { assertNever, modifyObject } from '../../utils/typescript.js'
import { refreshConfirmTransactionSimulation } from '../confirmTransactionSimulation.js'
import { refreshPopupVisualisationForOpenConsumer, type OpenConsumerVisualisationDependencies } from '../popupVisualisationUpdater.js'
import { sendCallbackToAllConfirmedSignerOwners } from '../signerStateOwnership.js'
import { visualizeSimulatorState } from '../simulationUpdating.js'
import { getChainChangeConfirmationPromise, getFetchSimulationStackRequestPromise, getPendingAccessRequests, getPendingTransactionsAndMessages, getPopupVisualisationState, getRpcConnectionStatus, updatePendingTransactionOrMessage } from '../storageVariables.js'
import { resolveChainChange, updateChainChangeViewWithPendingRequest } from '../windows/changeChain.js'
import { formEthSendTransaction, formSendRawTransaction, getReviewRevision, resolvePendingTransactionOrMessage, sendConfirmTransactionDialogUpdate, toPopupPendingTransactionOrSignableMessage, updateConfirmTransactionView } from '../windows/confirmTransaction.js'
import { updateFetchSimulationStackRequestWithPendingRequest } from '../windows/fetchSimulationStack.js'
import { refreshSignerAccountsForTab, refreshSignerAccountsFromApprovedWebsitePorts, updateInterceptorAccessViewWithPendingRequests } from '../windows/interceptorAccess.js'
import { craftPersonalSignPopupMessage } from '../windows/personalSign.js'
import { resolveWatchAsset, updateWatchAssetViewWithPendingRequest } from '../windows/watchAsset.js'

type SafeSignerAccountRefresh = Awaited<ReturnType<typeof refreshSignerAccountsForTab>>

export function getSafeSignerSelectionFromAccountRefresh(refreshResult: SafeSignerAccountRefresh) {
	return {
		selectedSigner: refreshResult?.error === undefined ? refreshResult?.accounts[0] : undefined,
		verificationError: refreshResult?.error?.message ?? (refreshResult === undefined ? 'The connected signer wallet is unavailable.' : undefined),
	}
}

export async function confirmDialog(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, confirmation: TransactionConfirmation) {
	// Before any await: the signer account refresh below can finish after another accept of the same request asked the user to review it again.
	const reviewedRevision = getReviewRevision(websiteTabConnections, confirmation.data.uniqueRequestIdentifier)
	const pending = confirmation.data.action === 'accept'
		? (await getPendingTransactionsAndMessages()).find((entry) =>
			doesUniqueRequestIdentifiersMatch(entry.uniqueRequestIdentifier, confirmation.data.uniqueRequestIdentifier)
		)
		: undefined
	const refreshedSafeSignerSelection = pending !== undefined && getSafePendingFlow(pending) !== undefined
		? await (async () => {
			const refreshResult = await refreshSignerAccountsForTab(
				websiteTabConnections,
				pending.uniqueRequestIdentifier.requestSocket.tabId,
				false,
			)
			return getSafeSignerSelectionFromAccountRefresh(refreshResult)
		})()
		: undefined
	// Wallet account refresh may outlive an RPC switch; resolution starts with the installed pair.
	const { ethereum, tokenPriceService } = simulationServicesOwner.getCurrent()
	await resolvePendingTransactionOrMessage(ethereum, tokenPriceService, websiteTabConnections, confirmation, refreshedSafeSignerSelection, reviewedRevision)
}

const createPopupReadyReply = <ConfirmTransactionBootstrap>(popupOrTabId: PopupOrTabId, confirmTransactionBootstrap: ConfirmTransactionBootstrap) => ({
	method: 'popup_readyAndListening' as const,
	data: { popupOrTabId, confirmTransactionBootstrap },
})

// Sends the dialog its pending request and returns the popup or tab that request belongs to.
async function publishPendingRequestToDialog(websiteTabConnections: WebsiteTabConnections, page: Exclude<PopupReadyAndListeningPage, 'confirmTransaction'>): Promise<PopupOrTabId | undefined> {
	switch (page) {
		case 'watchAsset': return (await updateWatchAssetViewWithPendingRequest(websiteTabConnections))?.popupOrTabId
		case 'changeChain': {
			const pendingChainChange = await getChainChangeConfirmationPromise()
			if (pendingChainChange === undefined) return undefined
			await updateChainChangeViewWithPendingRequest()
			return pendingChainChange.popupOrTabId
		}
		case 'interceptorAccess': {
			const [firstPendingAccessRequest] = await getPendingAccessRequests()
			if (firstPendingAccessRequest === undefined) return undefined
			await updateInterceptorAccessViewWithPendingRequests()
			return firstPendingAccessRequest.popupOrTabId
		}
		case 'fetchSimulationStack': {
			const pendingStackRequest = await getFetchSimulationStackRequestPromise()
			if (pendingStackRequest === undefined) return undefined
			await updateFetchSimulationStackRequestWithPendingRequest()
			return pendingStackRequest.popupOrTabId
		}
		default: return assertNever(page)
	}
}

export async function popupReadyAndListening(ethereum: EthereumClientService, websiteTabConnections: WebsiteTabConnections, page: PopupReadyAndListeningPage) {
	if (page === 'confirmTransaction') {
		const pendingTransactions = await getPendingTransactionsAndMessages()
		const [firstPendingTransaction] = pendingTransactions
		if (firstPendingTransaction === undefined) return undefined
		return createPopupReadyReply(firstPendingTransaction.popupOrTabId, {
			pendingTransactionAndSignableMessages: pendingTransactions.map(toPopupPendingTransactionOrSignableMessage),
			currentBlockNumber: await ethereum.getBlockNumber(undefined),
			rpcConnectionStatus: await getRpcConnectionStatus(),
			visualizedSimulatorState: await getPopupVisualisationState(),
		})
	}
	const popupOrTabId = await publishPendingRequestToDialog(websiteTabConnections, page)
	return popupOrTabId === undefined ? undefined : createPopupReadyReply(popupOrTabId, undefined)
}

export async function watchAssetDialog(websiteTabConnections: WebsiteTabConnections, confirmation: WatchAssetConfirmation) {
	await resolveWatchAsset(websiteTabConnections, confirmation)
}

export async function changeChainDialog(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, chainChange: ChainChangeConfirmation) {
	await resolveChainChange(simulationServicesOwner, websiteTabConnections, chainChange)
}

export async function requestAccountsFromSigner(websiteTabConnections: WebsiteTabConnections, params: RequestAccountsFromSigner) {
	if (params.data) {
		await refreshSignerAccountsFromApprovedWebsitePorts(websiteTabConnections, true)
		sendCallbackToAllConfirmedSignerOwners(websiteTabConnections, { method: 'request_signer_chainId', result: [] })
	}
}

type ConfirmTransactionMetadataDependencies = {
	readonly visualisation?: OpenConsumerVisualisationDependencies
}

type SimulationTimestamps = {
	readonly data: {
		readonly simulationStartedTimestamp: Date
		readonly simulationState: { readonly simulationConductedTimestamp: Date }
	}
}

const isSameSimulation = (first: SimulationTimestamps, second: SimulationTimestamps) => first.data.simulationStartedTimestamp.getTime() === second.data.simulationStartedTimestamp.getTime()
	&& first.data.simulationState.simulationConductedTimestamp.getTime() === second.data.simulationState.simulationConductedTimestamp.getTime()

export async function refreshPopupConfirmTransactionMetadata(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, requestAbortController: AbortController | undefined, dependencies: ConfirmTransactionMetadataDependencies = {}) {
	const [first] = await getPendingTransactionsAndMessages()
	if (first === undefined) return
	const currentBlockNumberPromise = ethereum.getBlockNumber(requestAbortController)
	silenceChromeUnCaughtPromise(currentBlockNumberPromise)
	const rpcConnectionStatusPromise = silenceChromeUnCaughtPromise(getRpcConnectionStatus())
	// Signing confirmations are independent of the simulation-mode stack. Safe proposals carry their own isolated optimistic simulation in the pending transaction payload.
	const visualizedSimulatorStatePromise = first.simulationMode
		? silenceChromeUnCaughtPromise(refreshPopupVisualisationForOpenConsumer(ethereum, tokenPriceService, dependencies.visualisation))
		: Promise.resolve(createPassthroughCompleteVisualizedSimulation())
	const isFirst = (pending: PendingTransactionOrSignableMessage) => doesUniqueRequestIdentifiersMatch(pending.uniqueRequestIdentifier, first.uniqueRequestIdentifier)
	// List the requests as stored after the refresh, so the dialog never shows the snapshot read before it started.
	const sendDialogUpdate = async (refreshStoredFirst: (storedFirst: PendingTransactionOrSignableMessage) => PendingTransactionOrSignableMessage) => {
		const storedPending = await getPendingTransactionsAndMessages()
		if (!storedPending.some(isFirst)) return
		await sendConfirmTransactionDialogUpdate({
			pendingTransactionAndSignableMessages: storedPending.map((pending) => isFirst(pending) ? refreshStoredFirst(pending) : pending),
			visualizedSimulatorState: await visualizedSimulatorStatePromise,
			currentBlockNumber: await currentBlockNumberPromise,
			rpcConnectionStatus: await rpcConnectionStatusPromise,
		})
	}
	switch (first.type) {
		case 'SignableMessage': {
			const visualizedPersonalSignRequestPromise = craftPersonalSignPopupMessage(ethereum, requestAbortController, first.signedMessageTransaction, ethereum.getRpcEntry())
			silenceChromeUnCaughtPromise(visualizedPersonalSignRequestPromise)
			const visualizedPersonalSignRequest = await visualizedPersonalSignRequestPromise
			await sendDialogUpdate((pending) => pending.type === 'SignableMessage'
				? { ...pending, visualizedPersonalSignRequest, transactionOrMessageCreationStatus: 'Simulated' as const }
				: pending
			)
			return
		}
		case 'Transaction': {
			if (first.transactionOrMessageCreationStatus !== 'Simulated' || first.popupVisualisation.statusCode === 'failed') return
			try {
				const visualizedSimulationState = await visualizeSimulatorState(first.popupVisualisation.data.simulationState, ethereum, tokenPriceService, requestAbortController)
				const visualizedPopupVisualisation: ConfirmTransactionTransactionSingleVisualization = {
					statusCode: 'success',
					data: modifyObject(first.popupVisualisation.data, { ...visualizedSimulationState }),
				}
				// Patch only the visualisation, and only while the stored request still holds the simulation it was computed from; the user may have accepted or a newer simulation may have landed meanwhile.
				const storedFirst = await updatePendingTransactionOrMessage(first.uniqueRequestIdentifier, async (current) => {
					if (current.type !== 'Transaction' || current.transactionOrMessageCreationStatus !== 'Simulated' || current.popupVisualisation.statusCode !== 'success') return undefined
					if (!isSameSimulation(current.popupVisualisation, first.popupVisualisation)) return undefined
					return { ...current, popupVisualisation: visualizedPopupVisualisation }
				})
				if (storedFirst === undefined) return
				await sendDialogUpdate((stored) => stored)
				return
			} catch(error: unknown) {
				if (isExpectedInfrastructureError(error)) return
				throw error
			}
		}
		default: assertNever(first)
	}
}

type TimestampedPopupVisualisation = {
	data: {
		simulationState: {
			simulationConductedTimestamp: Date
		}
	}
}

const getSimulationConductedTimestamp = (popupVisualisation: TimestampedPopupVisualisation) => popupVisualisation.data.simulationState.simulationConductedTimestamp

export async function refreshPopupConfirmTransactionSimulation(ethereum: EthereumClientService, tokenPriceService: TokenPriceService) {
	const [firstTxn] = await getPendingTransactionsAndMessages()
	if (firstTxn === undefined || firstTxn.type !== 'Transaction' || (firstTxn.transactionOrMessageCreationStatus !== 'Simulated' && firstTxn.transactionOrMessageCreationStatus !== 'FailedToSimulate')) return
	const safeFlow = getSafePendingFlow(firstTxn)
	const proposalSafeTransaction = safeFlow?.kind === 'proposal' ? safeFlow.pending.safeTransaction : undefined
	const transactionToSimulate = firstTxn.originalRequestParameters.method === 'eth_sendTransaction'
		? await formEthSendTransaction(
			ethereum,
			undefined,
			firstTxn.activeAddress,
			firstTxn.transactionToSimulate.website,
			firstTxn.originalRequestParameters,
			firstTxn.created,
			firstTxn.transactionIdentifier,
			firstTxn.simulationMode,
			safeFlow === undefined ? 'transaction-sender' : 'external-executor',
		)
		: await formSendRawTransaction(ethereum, firstTxn.originalRequestParameters, firstTxn.transactionToSimulate.website, firstTxn.created, firstTxn.transactionIdentifier)
	const refreshMessage = await refreshConfirmTransactionSimulation(
		ethereum,
		tokenPriceService,
		firstTxn.activeAddress,
		firstTxn.simulationMode,
		firstTxn.uniqueRequestIdentifier,
		transactionToSimulate,
		proposalSafeTransaction,
	)
	if (refreshMessage === undefined) return
	await updatePendingTransactionOrMessage(firstTxn.uniqueRequestIdentifier, async (transactionOrMessage) => {
		switch (transactionOrMessage.type) {
			case 'SignableMessage': throw new Error('Tried to refresh simulation of a message')
			case 'Transaction': {
				if (transactionOrMessage.transactionOrMessageCreationStatus !== 'Simulated' && transactionOrMessage.transactionOrMessageCreationStatus !== 'FailedToSimulate') return transactionOrMessage
				const currentTimestamp = getSimulationConductedTimestamp(transactionOrMessage.popupVisualisation)
				const nextTimestamp = getSimulationConductedTimestamp(refreshMessage)
				if (currentTimestamp !== undefined && nextTimestamp !== undefined && nextTimestamp.getTime() < currentTimestamp.getTime()) return transactionOrMessage
				if (transactionToSimulate.success) {
					return {
						...transactionOrMessage,
						transactionToSimulate,
						popupVisualisation: refreshMessage,
						transactionOrMessageCreationStatus: 'Simulated' as const,
					}
				}
				return {
					...transactionOrMessage,
					transactionToSimulate,
					popupVisualisation: refreshMessage,
					transactionOrMessageCreationStatus: 'FailedToSimulate' as const,
				}
			}
			default: assertNever(transactionOrMessage)
		}
	})
	await updateConfirmTransactionView(ethereum, tokenPriceService, true)
}
