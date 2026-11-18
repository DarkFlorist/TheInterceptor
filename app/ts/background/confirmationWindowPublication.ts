// What the confirmation window is sent of the stored confirmation queue and of the simulation, and nothing else. It reads the queue only under the lock of its writers and derives the network refusals through transactionNetwork.ts, so it needs neither the confirmation resolution in windows/confirmTransaction.ts nor the popup handlers in popupMessageHandlers.ts, and both use it without importing each other for it.
import type { PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import { UpdateConfirmTransactionDialog, UpdateConfirmTransactionDialogPendingTransactions } from '../types/interceptor-messages.js'
import { createPassthroughCompleteVisualizedSimulation } from '../types/visualizer-types.js'
import { serialize } from '../types/wire-types.js'
import type { GetInstalledServices } from '../simulation/serviceLifecycle.js'
import { isExpectedInfrastructureError, reportUnexpectedError } from '../utils/errors.js'
import { toPopupPendingTransactionOrSignableMessage } from '../utils/popupPendingRequest.js'
import { silenceChromeUnCaughtPromise } from '../utils/requests.js'
import { sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { updatePopupVisualisationIfNeeded } from './popupVisualisationUpdater.js'
import { getSettings } from './settings.js'
import { buildFromPendingTransactionsAndMessages, getRpcConnectionStatus, publishPendingTransactionsAndMessages } from './storageVariables.js'
import { showWithCurrentNetworkRefusals } from './transactionNetwork.js'

type ShowPending = (pending: readonly PendingTransactionOrSignableMessage[]) => readonly PendingTransactionOrSignableMessage[]

// The one builder of what the confirmation window is sent: the queue as it is stored at this moment, the window's only source of it, and with a view also the simulation view and the block data, which come after the queue. A push must never be older than the moment it is sent, or it could undo a later change, such as an approval handed to the signer, after the window has shown that change. So the stored confirmations are read here, under the lock of their writers, in the same step as the send, and a caller with slow work sends the queue only after it. The refusals shown with the queue are derived by showWithCurrentNetworkRefusals as the last step before the queue is built under that lock, from the active network and the client getInstalledServices returns at that moment, read together, so a client captured before slow work is never used and a switch during the publication never pairs an old network with a new client. showPending adds what a caller has prepared but not stored.
export async function publishConfirmationView(getInstalledServices: GetInstalledServices, view: UpdateConfirmTransactionDialog['data'] | undefined, showPending: ShowPending = (pending) => pending) {
	return await publishPendingTransactionsAndMessages(async (pending) => {
		if (pending.length === 0) return []
		const messagePendingTransactions: UpdateConfirmTransactionDialogPendingTransactions = {
			method: 'popup_update_confirm_transaction_dialog_pending_transactions' as const,
			data: { pendingTransactionAndSignableMessages: await projectConfirmationQueue(getInstalledServices, pending, showPending) },
		}
		const queueMessage = serialize(UpdateConfirmTransactionDialogPendingTransactions, messagePendingTransactions)
		if (view === undefined) return [queueMessage]
		const message: UpdateConfirmTransactionDialog = { method: 'popup_update_confirm_transaction_dialog', data: view }
		return [queueMessage, serialize(UpdateConfirmTransactionDialog, message)]
	}, async (message) => await sendPopupMessageToOpenWindows(message, 'confirmTransaction'))
}

// The one projection of the stored queue for the window, run under the queue lock by both the push and the bootstrap reply. The refusals are derived as its last step, from the active network and the client getInstalledServices returns, read together.
async function projectConfirmationQueue(getInstalledServices: GetInstalledServices, pending: readonly PendingTransactionOrSignableMessage[], showPending: ShowPending = (stored) => stored) {
	return await showWithCurrentNetworkRefusals(getInstalledServices, (getNetworkRefusalMessage) => showPending(pending).map((current) => toPopupPendingTransactionOrSignableMessage(current, getNetworkRefusalMessage)))
}

// The queue for the window's bootstrap reply, read and projected under the queue lock as a push is, so no write lands between reading the queue and deriving its refusals. The reply's slow lookups run before this.
export const readConfirmationQueue = async (getInstalledServices: GetInstalledServices) => await buildFromPendingTransactionsAndMessages(async (pending) => await projectConfirmationQueue(getInstalledServices, pending))

// Sends the confirmation window the stored queue, which needs no RPC. It is sent after every stored change, before anything else happens, such as the wallet being prompted, and whenever the window asks for it, as it does when it opens and when the network, the client or the settings change.
export const publishConfirmationQueue = async (getInstalledServices: GetInstalledServices) => await publishConfirmationView(getInstalledServices, undefined)

// Sends the simulation view and the block data, without the queue: they wait for an RPC, so the queue goes out before the slow work instead, as soon as it is stored.
async function publishSimulationView(view: UpdateConfirmTransactionDialog['data']) {
	const message: UpdateConfirmTransactionDialog = { method: 'popup_update_confirm_transaction_dialog', data: view }
	await sendPopupMessageToOpenWindows(serialize(UpdateConfirmTransactionDialog, message), 'confirmTransaction')
}

// Sends the simulation view with the block data, which waits for an RPC to the services installed when it starts.
export async function updateConfirmationSimulationView(getInstalledServices: GetInstalledServices, onlyIfNotAlreadyUpdating: boolean) {
	const { ethereum, tokenPriceService } = getInstalledServices()
	const currentBlockNumberPromise = silenceChromeUnCaughtPromise(ethereum.getBlockNumber(undefined))
	const rpcConnectionStatusPromise = silenceChromeUnCaughtPromise(getRpcConnectionStatus())
	const settings = await getSettings()
	const visualizedSimulatorState = settings.simulationMode
		? await updatePopupVisualisationIfNeeded(ethereum, tokenPriceService, { onlyIfNotAlreadyUpdating })
		: createPassthroughCompleteVisualizedSimulation()
	await publishSimulationView({ currentBlockNumber: await currentBlockNumberPromise, rpcConnectionStatus: await rpcConnectionStatusPromise, visualizedSimulatorState })
}

// Reports a failed window update, unless the RPC or the browser failed as they can at any time. It tells whether the update was sent, never.
export async function reportFailedWindowUpdate(error: unknown) {
	if (!isExpectedInfrastructureError(error)) await reportUnexpectedError(error)
	return false
}

// Tells the windows what is stored: the queue at once, then the simulation view once its RPC answers. It only reads: a stored status is changed by the code that owns it, never as a side effect of showing it. It tells whether a queue was shown.
export async function updateConfirmTransactionView(getInstalledServices: GetInstalledServices, onlyIfNotAlreadyUpdating = false) {
	try {
		if (!await publishConfirmationQueue(getInstalledServices)) return false
		await updateConfirmationSimulationView(getInstalledServices, onlyIfNotAlreadyUpdating)
		return true
	} catch(error: unknown) {
		return await reportFailedWindowUpdate(error)
	}
}
