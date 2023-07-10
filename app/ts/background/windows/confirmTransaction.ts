import { PopupOrTab, addWindowTabListener, closePopupOrTab, getPopupOrTabOnlyById, openPopupOrTab, removeWindowTabListener } from '../../components/ui-utils.js'
import { EthereumClientService } from '../../simulation/services/EthereumClientService.js'
import { appendTransaction } from '../../simulation/services/SimulationModeEthereumClientService.js'
import { ERROR_INTERCEPTOR_NO_ACTIVE_ADDRESS, METAMASK_ERROR_NOT_CONNECTED_TO_CHAIN, METAMASK_ERROR_USER_REJECTED_REQUEST } from '../../utils/constants.js'
import { Future } from '../../utils/future.js'
import { InterceptedRequest, TransactionConfirmation } from '../../utils/interceptor-messages.js'
import { Semaphore } from '../../utils/semaphore.js'
import { WebsiteSocket, WebsiteTabConnections } from '../../utils/user-interface-types.js'
import { EstimateGasError, WebsiteCreatedEthereumUnsignedTransaction } from '../../utils/visualizer-types.js'
import { SendRawTransaction, SendTransactionParams } from '../../utils/wire-types.js'
import { postMessageIfStillConnected, refreshConfirmTransactionSimulation, updateSimulationState } from '../background.js'
import { getHtmlFile, sendPopupMessageToOpenWindows } from '../backgroundUtils.js'
import { appendPendingTransaction, clearPendingTransactions, getPendingTransactions, getSimulationResults, removePendingTransaction } from '../storageVariables.js'

export type Confirmation = 'Approved' | 'Rejected' | 'NoResponse'
let openedDialog: PopupOrTab | undefined = undefined
let pendingTransactions = new Map<number, Future<Confirmation>>()
const pendingConfirmationSemaphore = new Semaphore(1)

export async function updateConfirmTransactionViewWithPendingTransaction() {
	const promises = await getPendingTransactions()
	if (promises.length >= 1) {
		await sendPopupMessageToOpenWindows({
			method: 'popup_update_confirm_transaction_dialog',
			data: promises.map((p) => p.simulationResults),
		})
		return true
	}
	return false
}

async function updateConfirmTransactionViewWithPendingTransactionOrClose() {
	if (await updateConfirmTransactionViewWithPendingTransaction() === true) return
	if (openedDialog) await closePopupOrTab(openedDialog)
	openedDialog = undefined
}

export async function resolvePendingTransaction(ethereumClientService: EthereumClientService, websiteTabConnections: WebsiteTabConnections, confirmation: TransactionConfirmation) {
	const pending = pendingTransactions.get(confirmation.data.requestId)
	const pendingTransaction = await removePendingTransaction(confirmation.data.requestId)
	if (pendingTransaction === undefined) return
	await updateConfirmTransactionViewWithPendingTransactionOrClose()
	if (pending) {
		return pending.resolve(confirmation.data.accept === true ? 'Approved' : 'Rejected')
	} else {
		// we have not been tracking this window, forward its message directly to content script (or signer)
		const resolvedPromise = await resolve(ethereumClientService, pendingTransaction.simulationMode, pendingTransaction.activeAddress, pendingTransaction.transactionToSimulate, confirmation.data.accept)
		postMessageIfStillConnected(websiteTabConnections, pendingTransaction.socket, { ...pendingTransaction.transactionParams, ...resolvedPromise, requestId: confirmation.data.requestId })
		openedDialog = await getPopupOrTabOnlyById(confirmation.data.windowId)
	}
}
const onCloseWindow = async (windowId: number) => { // check if user has closed the window on their own, if so, reject all signatures
	if (openedDialog === undefined || openedDialog.windowOrTab.id !== windowId) return
	openedDialog = undefined
	await clearPendingTransactions()
	pendingTransactions.forEach((pending) => pending.resolve('NoResponse'))
	pendingTransactions.clear()
}

const rejectMessage = {
	error: {
		code: METAMASK_ERROR_USER_REJECTED_REQUEST,
		message: 'Interceptor Tx Signature: User denied transaction signature.'
	}
}

export async function openConfirmTransactionDialog(
	ethereumClientService: EthereumClientService,
	socket: WebsiteSocket,
	request: InterceptedRequest,
	transactionParams: SendTransactionParams | SendRawTransaction,
	simulationMode: boolean,
	transactionToSimulatePromise: () => Promise<WebsiteCreatedEthereumUnsignedTransaction | undefined | EstimateGasError>,
	activeAddress: bigint | undefined,
) {
	let justAddToPending = false
	if (pendingTransactions.size !== 0) justAddToPending = true
	const pendingTransaction = new Future<Confirmation>()
	pendingTransactions.set(request.requestId, pendingTransaction)
	try {
		if (activeAddress === undefined) return ERROR_INTERCEPTOR_NO_ACTIVE_ADDRESS
		const transactionToSimulate = await transactionToSimulatePromise()
		if (transactionToSimulate === undefined) return rejectMessage
		if ('error' in transactionToSimulate) return transactionToSimulate

		const addedPendingTransaction = await pendingConfirmationSemaphore.execute(async () => {
			if (!justAddToPending) {
				const oldPromise = await getPendingTransactions()
				if (oldPromise.length !== 0) {
					if (await getPopupOrTabOnlyById(oldPromise[0].dialogId) !== undefined) {
						justAddToPending = true
					} else {
						await clearPendingTransactions()
					}
				}
			}
			const refreshSimulationPromise = refreshConfirmTransactionSimulation(ethereumClientService, activeAddress, simulationMode, request.requestId, transactionToSimulate, socket.tabId)

			if (!justAddToPending) {
				addWindowTabListener(onCloseWindow)
				openedDialog = await openPopupOrTab({
					url: getHtmlFile('confirmTransaction'),
					type: 'popup',
					height: 800,
					width: 600,
				})
			}
			if (openedDialog?.windowOrTab.id === undefined) return false
			await appendPendingTransaction({
				dialogId: openedDialog.windowOrTab.id,
				socket: socket,
				transactionParams: transactionParams,
				request: request,
				transactionToSimulate: transactionToSimulate,
				simulationMode: simulationMode,
				activeAddress: activeAddress,
				simulationResults: await refreshSimulationPromise,
			})
			await updateConfirmTransactionViewWithPendingTransaction()
			if (justAddToPending) sendPopupMessageToOpenWindows({ method: 'popup_confirm_transaction_dialog_pending_changed', data: (await getPendingTransactions()).map((p) => p.simulationResults) })
			return true
		})
		if (addedPendingTransaction === false) return rejectMessage
		const reply = await pendingTransaction
		const resolvedPromise = await resolve(ethereumClientService, simulationMode, activeAddress, transactionToSimulate, reply === 'Approved' ? true : false)
		return resolvedPromise
	} finally {
		removeWindowTabListener(onCloseWindow)
		pendingTransactions.delete(request.requestId)
		updateConfirmTransactionViewWithPendingTransactionOrClose()
	}
}

async function resolve(ethereumClientService: EthereumClientService, simulationMode: boolean, activeAddress: bigint, transactionToSimulate: WebsiteCreatedEthereumUnsignedTransaction, accept: boolean): Promise<{ forward: true } | { error: { code: number, message: string } } | { result: bigint }> {
	if (accept === false) return rejectMessage
	if (!simulationMode) return { forward: true }
	const newState = await updateSimulationState(async () => {
		const simulationState = (await getSimulationResults()).simulationState
		if (simulationState === undefined) return undefined
		return await appendTransaction(ethereumClientService, simulationState, transactionToSimulate)
	}, activeAddress)
	if (newState === undefined || newState.simulatedTransactions === undefined || newState.simulatedTransactions.length === 0) {
		return METAMASK_ERROR_NOT_CONNECTED_TO_CHAIN
	}
	return { result: newState.simulatedTransactions[newState.simulatedTransactions.length - 1].signedTransaction.hash }
}
