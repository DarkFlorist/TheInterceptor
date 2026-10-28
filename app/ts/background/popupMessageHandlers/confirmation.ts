import { getSafePendingFlow } from '../../safe/safePendingFlow.js'
import type { EthereumClientService } from '../../simulation/services/EthereumClientService.js'
import type { TokenPriceService } from '../../simulation/services/priceEstimator.js'
import type { SimulationServicesOwner } from '../../simulation/serviceLifecycle.js'
import { type ChainChangeConfirmation, type PopupReadyAndListeningPage, type RequestAccountsFromSigner, type TransactionConfirmation, type WatchAssetConfirmation, UpdateConfirmTransactionDialog, UpdateConfirmTransactionDialogPendingTransactions } from '../../types/interceptor-messages.js'
import type { WebsiteTabConnections } from '../../types/user-interface-types.js'
import { createPassthroughCompleteVisualizedSimulation } from '../../types/visualizer-types.js'
import { isExpectedInfrastructureError } from '../../utils/errors.js'
import { doesUniqueRequestIdentifiersMatch, silenceChromeUnCaughtPromise } from '../../utils/requests.js'
import { assertNever, modifyObject } from '../../utils/typescript.js'
import { refreshConfirmTransactionSimulation } from '../confirmTransactionSimulation.js'
import { refreshPopupVisualisationForOpenConsumer, type OpenConsumerVisualisationDependencies } from '../popupVisualisationUpdater.js'
import { sendCallbackToAllConfirmedSignerOwners } from '../signerStateOwnership.js'
import { visualizeSimulatorState } from '../simulationUpdating.js'
import { getChainChangeConfirmationPromise, getFetchSimulationStackRequestPromise, getPendingAccessRequests, getPendingTransactionsAndMessages, getPopupVisualisationState, getRpcConnectionStatus, updatePendingTransactionOrMessage } from '../storageVariables.js'
import { resolveChainChange, updateChainChangeViewWithPendingRequest } from '../windows/changeChain.js'
import { formEthSendTransaction, formSendRawTransaction, resolvePendingTransactionOrMessage, toPopupPendingTransactionOrSignableMessage, updateConfirmTransactionView } from '../windows/confirmTransaction.js'
import { updateFetchSimulationStackRequestWithPendingRequest } from '../windows/fetchSimulationStack.js'
import { refreshSignerAccountsForTab, refreshSignerAccountsFromApprovedWebsitePorts, updateInterceptorAccessViewWithPendingRequests } from '../windows/interceptorAccess.js'
import { craftPersonalSignPopupMessage } from '../windows/personalSign.js'
import { resolveWatchAsset, updateWatchAssetViewWithPendingRequest } from '../windows/watchAsset.js'
import { sendPopupMessageToOpenWindows } from '../backgroundUtils.js'
import { serialize } from '../../types/wire-types.js'

type SafeSignerAccountRefresh = Awaited<ReturnType<typeof refreshSignerAccountsForTab>>

export function getSafeSignerSelectionFromAccountRefresh(refreshResult: SafeSignerAccountRefresh) {
	return {
		selectedSigner: refreshResult?.error === undefined ? refreshResult?.accounts[0] : undefined,
		verificationError: refreshResult?.error?.message ?? (refreshResult === undefined ? 'The connected signer wallet is unavailable.' : undefined),
	}
}

export async function confirmDialog(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, confirmation: TransactionConfirmation) {
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
	await resolvePendingTransactionOrMessage(ethereum, tokenPriceService, websiteTabConnections, confirmation, refreshedSafeSignerSelection)
}

export async function popupReadyAndListening(ethereum: EthereumClientService, websiteTabConnections: WebsiteTabConnections, page: PopupReadyAndListeningPage) {
	switch (page) {
		case 'watchAsset': {
			const request = await updateWatchAssetViewWithPendingRequest(websiteTabConnections)
			if (request === undefined) return undefined
			return {
				method: 'popup_readyAndListening' as const,
				data: {
					popupOrTabId: request.popupOrTabId,
					confirmTransactionBootstrap: undefined,
				},
			}
		}
		case 'changeChain': {
			const promise = await getChainChangeConfirmationPromise()
			if (promise === undefined) return undefined
			await updateChainChangeViewWithPendingRequest()
			return {
				method: 'popup_readyAndListening' as const,
				data: {
					popupOrTabId: promise.popupOrTabId,
					confirmTransactionBootstrap: undefined,
				},
			}
		}
		case 'confirmTransaction': {
			const pendingTransactions = await getPendingTransactionsAndMessages()
			const firstPendingTransaction = pendingTransactions[0]
			if (firstPendingTransaction === undefined) return undefined
			const currentBlockNumber = await ethereum.getBlockNumber(undefined)
			const rpcConnectionStatus = await getRpcConnectionStatus()
			const visualizedSimulatorState = await getPopupVisualisationState()
			return {
				method: 'popup_readyAndListening' as const,
				data: {
					popupOrTabId: firstPendingTransaction.popupOrTabId,
					confirmTransactionBootstrap: {
						pendingTransactionAndSignableMessages: pendingTransactions.map(toPopupPendingTransactionOrSignableMessage),
						currentBlockNumber,
						rpcConnectionStatus,
						visualizedSimulatorState,
					},
				},
			}
		}
		case 'interceptorAccess': {
			const pendingAccessRequests = await getPendingAccessRequests()
			const firstPendingAccessRequest = pendingAccessRequests[0]
			if (firstPendingAccessRequest === undefined) return undefined
			await updateInterceptorAccessViewWithPendingRequests()
			return {
				method: 'popup_readyAndListening' as const,
				data: {
					popupOrTabId: firstPendingAccessRequest.popupOrTabId,
					confirmTransactionBootstrap: undefined,
				},
			}
		}
		case 'fetchSimulationStack': {
			const promise = await getFetchSimulationStackRequestPromise()
			if (promise === undefined) return undefined
			await updateFetchSimulationStackRequestWithPendingRequest()
			return {
				method: 'popup_readyAndListening' as const,
				data: {
					popupOrTabId: promise.popupOrTabId,
					confirmTransactionBootstrap: undefined,
				},
			}
		}
		default:
			assertNever(page)
	}
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

export async function refreshPopupConfirmTransactionMetadata(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, requestAbortController: AbortController | undefined, dependencies: ConfirmTransactionMetadataDependencies = {}) {
	const promises = await getPendingTransactionsAndMessages()
	const first = promises[0]
	if (first === undefined) return
	const currentBlockNumberPromise = ethereum.getBlockNumber(requestAbortController)
	silenceChromeUnCaughtPromise(currentBlockNumberPromise)
	const rpcConnectionStatusPromise = silenceChromeUnCaughtPromise(getRpcConnectionStatus())
	// Signing confirmations are independent of the simulation-mode stack. Safe proposals carry their own isolated optimistic simulation in the pending transaction payload.
	const visualizedSimulatorStatePromise = first.simulationMode
		? silenceChromeUnCaughtPromise(refreshPopupVisualisationForOpenConsumer(ethereum, tokenPriceService, dependencies.visualisation))
		: Promise.resolve(createPassthroughCompleteVisualizedSimulation())
	switch (first.type) {
		case 'SignableMessage': {
			const visualizedPersonalSignRequestPromise = craftPersonalSignPopupMessage(ethereum, requestAbortController, first.signedMessageTransaction, ethereum.getRpcEntry())
			silenceChromeUnCaughtPromise(visualizedPersonalSignRequestPromise)
			const message: UpdateConfirmTransactionDialog = {
				method: 'popup_update_confirm_transaction_dialog',
				data: {
					visualizedSimulatorState: await visualizedSimulatorStatePromise,
					currentBlockNumber: await currentBlockNumberPromise,
					rpcConnectionStatus: await rpcConnectionStatusPromise,
				}
			}
			const messagePendingTransactions: UpdateConfirmTransactionDialogPendingTransactions = {
				method: 'popup_update_confirm_transaction_dialog_pending_transactions' as const,
				data: {
					pendingTransactionAndSignableMessages: [{
						...first,
						visualizedPersonalSignRequest: await visualizedPersonalSignRequestPromise,
						transactionOrMessageCreationStatus: 'Simulated' as const
					}, ...promises.slice(1)].map(toPopupPendingTransactionOrSignableMessage),
					currentBlockNumber: await currentBlockNumberPromise,
					rpcConnectionStatus: await rpcConnectionStatusPromise,
				}
			}
			await Promise.all([
				sendPopupMessageToOpenWindows(serialize(UpdateConfirmTransactionDialogPendingTransactions, messagePendingTransactions), 'confirmTransaction'),
				sendPopupMessageToOpenWindows(serialize(UpdateConfirmTransactionDialog, message), 'confirmTransaction')
			])
			return
		}
		case 'Transaction': {
			if (first.transactionOrMessageCreationStatus !== 'Simulated' || first.popupVisualisation.statusCode === 'failed') return
			try {
				const visualizedSimulationState = await visualizeSimulatorState(first.popupVisualisation.data.simulationState, ethereum, tokenPriceService, requestAbortController)
				const updatedFirst = modifyObject(first,
					{
						popupVisualisation: {
							statusCode: 'success',
							data: modifyObject(first.popupVisualisation.data, { ...visualizedSimulationState })
						}
					})
				await updatePendingTransactionOrMessage(first.uniqueRequestIdentifier, async () => updatedFirst)
				const messagePendingTransactions: UpdateConfirmTransactionDialogPendingTransactions = {
					method: 'popup_update_confirm_transaction_dialog_pending_transactions' as const,
					data: {
						pendingTransactionAndSignableMessages: [
							updatedFirst
							, ...promises.slice(1)].map(toPopupPendingTransactionOrSignableMessage),
						currentBlockNumber: await currentBlockNumberPromise,
						rpcConnectionStatus: await rpcConnectionStatusPromise,
					}
				}
				const message: UpdateConfirmTransactionDialog = {
					method: 'popup_update_confirm_transaction_dialog' as const,
					data: {
						visualizedSimulatorState: await visualizedSimulatorStatePromise,
						currentBlockNumber: await currentBlockNumberPromise,
						rpcConnectionStatus: await rpcConnectionStatusPromise,
					}
				}
				await Promise.all([
					sendPopupMessageToOpenWindows(serialize(UpdateConfirmTransactionDialogPendingTransactions, messagePendingTransactions), 'confirmTransaction'),
					sendPopupMessageToOpenWindows(serialize(UpdateConfirmTransactionDialog, message), 'confirmTransaction')
				])
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
