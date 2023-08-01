import { PopupOrTab, addWindowTabListener, closePopupOrTab, getPopupOrTabOnlyById, openPopupOrTab, removeWindowTabListener } from '../../components/ui-utils.js'
import { EthereumClientService } from '../../simulation/services/EthereumClientService.js'
import { appendTransaction } from '../../simulation/services/SimulationModeEthereumClientService.js'
import { ERROR_INTERCEPTOR_NO_ACTIVE_ADDRESS, METAMASK_ERROR_NOT_CONNECTED_TO_CHAIN, METAMASK_ERROR_USER_REJECTED_REQUEST } from '../../utils/constants.js'
import { Future } from '../../utils/future.js'
import { TransactionConfirmation } from '../../utils/interceptor-messages.js'
import { Semaphore } from '../../utils/semaphore.js'
import { WebsiteTabConnections } from '../../utils/user-interface-types.js'
import { EstimateGasError, WebsiteCreatedEthereumUnsignedTransaction } from '../../utils/visualizer-types.js'
import { SendRawTransaction, SendTransactionParams } from '../../utils/JsonRpc-types.js'
import { refreshConfirmTransactionSimulation, updateSimulationState } from '../background.js'
import { getHtmlFile, sendPopupMessageToOpenWindows } from '../backgroundUtils.js'
import { appendPendingTransaction, clearPendingTransactions, getPendingTransactions, removePendingTransaction } from '../storageVariables.js'
import { InterceptedRequest, getUniqueRequestIdentifierString } from '../../utils/requests.js'
import { replyToInterceptedRequest } from '../messageSending.js'
import { Simulator } from '../../simulation/simulator.js'

export type Confirmation = 'Approved' | 'Rejected' | 'NoResponse'
let openedDialog: PopupOrTab | undefined = undefined
let pendingTransactions = new Map<string, Future<Confirmation>>()
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

export async function resolvePendingTransaction(simulator: Simulator, ethereumClientService: EthereumClientService, websiteTabConnections: WebsiteTabConnections, confirmation: TransactionConfirmation) {
	const pending = pendingTransactions.get(getUniqueRequestIdentifierString(confirmation.data.uniqueRequestIdentifier))
	const pendingTransaction = await removePendingTransaction(confirmation.data.uniqueRequestIdentifier)
	if (pendingTransaction === undefined) throw new Error('Failed to find pending transaction')
	await updateConfirmTransactionViewWithPendingTransactionOrClose()
	if (pending) {
		return pending.resolve(confirmation.data.accept === true ? 'Approved' : 'Rejected')
	} else {
		// we have not been tracking this window, forward its message directly to content script (or signer)
		const resolvedPromise = await resolve(simulator, ethereumClientService, pendingTransaction.simulationMode, pendingTransaction.activeAddress, pendingTransaction.transactionToSimulate, confirmation.data.accept)
		replyToInterceptedRequest(websiteTabConnections, { ...pendingTransaction.transactionParams, ...resolvedPromise, uniqueRequestIdentifier: confirmation.data.uniqueRequestIdentifier })
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
	simulator: Simulator,
	ethereumClientService: EthereumClientService,
	request: InterceptedRequest,
	transactionParams: SendTransactionParams | SendRawTransaction,
	simulationMode: boolean,
	transactionToSimulatePromise: () => Promise<WebsiteCreatedEthereumUnsignedTransaction | undefined | EstimateGasError>,
	activeAddress: bigint | undefined,
) {
	let justAddToPending = false
	if (pendingTransactions.size !== 0) justAddToPending = true
	const pendingTransaction = new Future<Confirmation>()
	const uniqueRequestIdentifier = getUniqueRequestIdentifierString(request.uniqueRequestIdentifier)
	pendingTransactions.set(uniqueRequestIdentifier, pendingTransaction)
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
			const refreshSimulationPromise = refreshConfirmTransactionSimulation(simulator, ethereumClientService, activeAddress, simulationMode, request.uniqueRequestIdentifier, transactionToSimulate)

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
				transactionParams: transactionParams,
				request: request,
				transactionToSimulate: transactionToSimulate,
				simulationMode: simulationMode,
				activeAddress: activeAddress,
				simulationResults: await refreshSimulationPromise,
			})
			await updateConfirmTransactionViewWithPendingTransaction()
			if (justAddToPending) await sendPopupMessageToOpenWindows({ method: 'popup_confirm_transaction_dialog_pending_changed', data: (await getPendingTransactions()).map((p) => p.simulationResults) })
			return true
		})
		if (addedPendingTransaction === false) return rejectMessage
		const reply = await pendingTransaction
		const resolvedPromise = await resolve(simulator, ethereumClientService, simulationMode, activeAddress, transactionToSimulate, reply === 'Approved' ? true : false)
		return resolvedPromise
	} finally {
		removeWindowTabListener(onCloseWindow)
		pendingTransactions.delete(uniqueRequestIdentifier)
		updateConfirmTransactionViewWithPendingTransactionOrClose()
	}
}

async function resolve(simulator: Simulator, ethereumClientService: EthereumClientService, simulationMode: boolean, activeAddress: bigint, transactionToSimulate: WebsiteCreatedEthereumUnsignedTransaction, accept: boolean): Promise<{ forward: true } | { error: { code: number, message: string } } | { result: bigint }> {
	if (accept === false) return rejectMessage
	if (!simulationMode) return { forward: true }
	const newState = await updateSimulationState(simulator, async (simulationState) => {
		if (simulationState === undefined) return undefined
		return await appendTransaction(ethereumClientService, simulationState, transactionToSimulate)
	}, activeAddress, true)
	if (newState === undefined || newState.simulatedTransactions === undefined || newState.simulatedTransactions.length === 0) {
		return METAMASK_ERROR_NOT_CONNECTED_TO_CHAIN
	}
	return { result: newState.simulatedTransactions[newState.simulatedTransactions.length - 1].signedTransaction.hash }
}
