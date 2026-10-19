import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { TokenPriceService } from '../simulation/services/priceEstimator.js'
import type { PendingTransactionOrSignableMessage, PopupPendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import { UpdateConfirmTransactionDialog, UpdateConfirmTransactionDialogPendingTransactions } from '../types/interceptor-messages.js'
import type { RpcConnectionStatus } from '../types/user-interface-types.js'
import { type CompleteVisualizedSimulation, createPassthroughCompleteVisualizedSimulation } from '../types/visualizer-types.js'
import { serialize } from '../types/wire-types.js'
import { isExpectedInfrastructureError, reportUnexpectedError } from '../utils/errors.js'
import { closePopupOrTabById, openPopupOrTab, getPopupOrTabById, tryFocusingTabOrWindow } from '../utils/popupOrTab.js'
import { silenceChromeUnCaughtPromise } from '../utils/requests.js'
import { Semaphore } from '../utils/semaphore.js'
import { assertNever } from '../utils/typescript.js'
import { getHtmlFile, sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { updatePopupVisualisationIfNeeded } from './popupVisualisationUpdater.js'
import { getSettings } from './settings.js'
import { getPendingTransactionsAndMessages, getRpcConnectionStatus } from './storageVariables.js'

// The confirmation queue and window that the confirmation window module and wallet_sendCalls batches share: the admission lock, the window that shows the queue, its view updates, the ordering of stored previews and the rejection reply format.

const pendingConfirmationSemaphore = new Semaphore(1)
// Requests are added to the confirmation queue one at a time while holding this lock.
export const runWithPendingConfirmationLock = async <T>(run: () => Promise<T>) => await pendingConfirmationSemaphore.execute(run)

export const formRejectMessage = (code: number, errorString: string) => {
	return {
		type: 'result' as const,
		error: { code, message: errorString }
	}
}

// Answers the requests of a confirmation window that was closed. The confirmation window module provides it, because answering a request dispatches on its kind, wallet_sendCalls batches included.
export type AnswerRequestsOfClosedWindow = (pendingRequests: readonly PendingTransactionOrSignableMessage[]) => Promise<void>

// The window that shows the confirmation queue: the open one, or a new one once the requests of a closed window were answered.
export const getPendingTransactionWindow = async (answerRequestsOfClosedWindow: AnswerRequestsOfClosedWindow) => {
	const pendingTransactions = await getPendingTransactionsAndMessages()
	const [firstPendingTransaction] = pendingTransactions
	if (firstPendingTransaction !== undefined) {
		const alreadyOpenWindow = await getPopupOrTabById(firstPendingTransaction.popupOrTabId)
		if (alreadyOpenWindow) return alreadyOpenWindow
		await answerRequestsOfClosedWindow(pendingTransactions)
	}
	return await openPopupOrTab({ url: getHtmlFile('confirmTransaction'), type: 'popup', height: 800, width: 600 })
}

type TimestampedPopupVisualisation = {
	statusCode: 'success' | 'failed'
	data: {
		simulationStartedTimestamp: Date
		simulationId?: number
		simulationState: {
			simulationConductedTimestamp: Date
		}
	}
}

const getSimulationStartedTimestamp = (popupVisualisation: TimestampedPopupVisualisation) => popupVisualisation.data.simulationStartedTimestamp

// A stored simulation run is only replaced by the same or a newer run, whether either run succeeded or failed. Stored start timestamps keep only whole seconds, so runs are ordered by simulationId when both have one, and by start time only when a run was stored by an older version without an id.
export const shouldReplacePopupVisualisation = (
	currentPopupVisualisation: TimestampedPopupVisualisation | undefined,
	nextPopupVisualisation: TimestampedPopupVisualisation,
) => {
	if (currentPopupVisualisation === undefined) return true
	const currentSimulationId = currentPopupVisualisation.data.simulationId
	const nextSimulationId = nextPopupVisualisation.data.simulationId
	if (currentSimulationId !== undefined && nextSimulationId !== undefined) return nextSimulationId >= currentSimulationId
	return getSimulationStartedTimestamp(nextPopupVisualisation).getTime() >= getSimulationStartedTimestamp(currentPopupVisualisation).getTime()
}

export function toPopupPendingTransactionOrSignableMessage(pending: PendingTransactionOrSignableMessage): PopupPendingTransactionOrSignableMessage {
	switch (pending.type) {
		case 'Transaction':
		case 'TransactionBatch':
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

// Sends the confirmation queue, together with the current simulation stack, to the confirmation window.
export async function sendConfirmTransactionDialogUpdates(pendingTransactionsAndMessages: readonly PendingTransactionOrSignableMessage[], visualizedSimulatorState: CompleteVisualizedSimulation, currentBlockNumber: bigint, rpcConnectionStatus: RpcConnectionStatus) {
	const messagePendingTransactions: UpdateConfirmTransactionDialogPendingTransactions = {
		method: 'popup_update_confirm_transaction_dialog_pending_transactions' as const,
		data: {
			pendingTransactionAndSignableMessages: pendingTransactionsAndMessages.map(toPopupPendingTransactionOrSignableMessage),
			currentBlockNumber,
			rpcConnectionStatus,
		}
	}
	const message: UpdateConfirmTransactionDialog = { method: 'popup_update_confirm_transaction_dialog', data: { currentBlockNumber, rpcConnectionStatus, visualizedSimulatorState } }
	await Promise.all([
		sendPopupMessageToOpenWindows(serialize(UpdateConfirmTransactionDialogPendingTransactions, messagePendingTransactions), 'confirmTransaction'),
		sendPopupMessageToOpenWindows(serialize(UpdateConfirmTransactionDialog, message), 'confirmTransaction')
	])
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
		await sendConfirmTransactionDialogUpdates(pendingTransactionAndSignableMessages, visualizedSimulatorState, await currentBlockNumberPromise, await rpcConnectionStatusPromise)
		return true
	} catch(error: unknown) {
		if (isExpectedInfrastructureError(error)) return false
		await reportUnexpectedError(error)
	}
	return false
}

export async function updateViewAfterPendingRequestRemoved(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, pending: PendingTransactionOrSignableMessage) {
	if ((await getPendingTransactionsAndMessages()).length === 0) await tryFocusingTabOrWindow({ type: 'tab', id: pending.uniqueRequestIdentifier.requestSocket.tabId })
	if (!(await updateConfirmTransactionView(ethereum, tokenPriceService))) await closePopupOrTabById(pending.popupOrTabId)
}
