import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { TokenPriceService } from '../simulation/services/priceEstimator.js'
import type { PendingTransactionOrSignableMessage, PopupPendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import { UpdateConfirmTransactionDialog, UpdateConfirmTransactionDialogPendingTransactions } from '../types/interceptor-messages.js'
import type { RpcConnectionStatus } from '../types/user-interface-types.js'
import { type CompleteVisualizedSimulation, createPassthroughCompleteVisualizedSimulation } from '../types/visualizer-types.js'
import { serialize } from '../types/wire-types.js'
import { isExpectedInfrastructureError, reportUnexpectedError } from '../utils/errors.js'
import { silenceChromeUnCaughtPromise } from '../utils/requests.js'
import { assertNever } from '../utils/typescript.js'
import { sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { updatePopupVisualisationIfNeeded } from './popupVisualisationUpdater.js'
import { getSettings } from './settings.js'
import { getPendingTransactionsAndMessages, getRpcConnectionStatus } from './storageVariables.js'

// What the confirmation window is sent: the confirmation queue in its popup wire format, together with the current simulation stack.

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
