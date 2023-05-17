import { EthereumClientService } from '../../simulation/services/EthereumClientService.js'
import { appendTransaction } from '../../simulation/services/SimulationModeEthereumClientService.js'
import { bytes32String } from '../../utils/bigint.js'
import { ERROR_INTERCEPTOR_NO_ACTIVE_ADDRESS, METAMASK_ERROR_NOT_CONNECTED_TO_CHAIN, METAMASK_ERROR_USER_REJECTED_REQUEST } from '../../utils/constants.js'
import { Future } from '../../utils/future.js'
import { ConfirmTransactionTransactionSingleVisualization, ExternalPopupMessage, InterceptedRequest, PendingTransaction, Settings, TransactionConfirmation } from '../../utils/interceptor-messages.js'
import { Semaphore } from '../../utils/semaphore.js'
import { Website, WebsiteSocket, WebsiteTabConnections } from '../../utils/user-interface-types.js'
import { EthereumUnsignedTransaction } from '../../utils/wire-types.js'
import { getActiveAddressForDomain } from '../accessManagement.js'
import { refreshConfirmTransactionSimulation, sendMessageToContentScript, updateSimulationState } from '../background.js'
import { getHtmlFile, sendPopupMessageToOpenWindows } from '../backgroundUtils.js'
import { appendPendingTransaction, clearPendingTransactions, getPendingTransactions, getSimulationResults, removePendingTransaction } from '../settings.js'

export type Confirmation = 'Approved' | 'Rejected' | 'NoResponse'
let openedConfirmTransactionDialogWindow: browser.windows.Window | null = null
let pendingTransactions = new Map<number, Future<Confirmation>>()
const pendingConfirmationSemaphore = new Semaphore(1)

async function updateConfirmTransactionViewWithPendingTransactionOrClose() {
	const promises = await getPendingTransactions()
	if (promises.length >= 1) {
		return sendPopupMessageToOpenWindows({
			method: 'popup_update_confirm_transaction_dialog',
			data: promises.map((p) => p.simulationResults),
		})
	}
	if (openedConfirmTransactionDialogWindow?.id !== undefined) {
		try {
			browser.windows.remove(openedConfirmTransactionDialogWindow.id)
		} catch (error) {
			console.warn(error)
		}
	}
	openedConfirmTransactionDialogWindow = null
}

export async function resolvePendingTransaction(ethereumClientService: EthereumClientService, websiteTabConnections: WebsiteTabConnections, confirmation: TransactionConfirmation) {
	const pending = pendingTransactions.get(confirmation.options.requestId)
	const pendingTransaction = await removePendingTransaction(confirmation.options.requestId)
	if (pendingTransaction === undefined) return
	await updateConfirmTransactionViewWithPendingTransactionOrClose()
	if (pending) {
		return pending.resolve(confirmation.options.accept === true ? 'Approved' : 'Rejected')
	} else {
		// we have not been tracking this window, forward its message directly to content script (or signer)
		const resolvedPromise = await resolve(ethereumClientService, pendingTransaction.simulationMode, pendingTransaction.activeAddress, pendingTransaction.transactionToSimulate, pendingTransaction.website, confirmation.options.accept)
		sendMessageToContentScript(websiteTabConnections, pendingTransaction.socket, resolvedPromise, pendingTransaction.request)
		try {
			openedConfirmTransactionDialogWindow = await browser.windows.get(confirmation.options.windowId)
		} catch(e) {
			console.warn(e)
		}
	}
}

const onCloseWindow = async (windowId: number) => { // check if user has closed the window on their own, if so, reject all signatures
	if (openedConfirmTransactionDialogWindow === null || openedConfirmTransactionDialogWindow.id !== windowId) return
	openedConfirmTransactionDialogWindow = null
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
	website: Website,
	simulationMode: boolean,
	transactionToSimulatePromise: () => Promise<EthereumUnsignedTransaction | undefined>,
	settings: Settings,
) {
	let justAddToPending = false
	if (pendingTransactions.size !== 0) justAddToPending = true
	const pendingTransaction = new Future<Confirmation>()
	pendingTransactions.set(request.requestId, pendingTransaction)

	const appendPromise = new Future<readonly PendingTransaction[]>()
	const windowReadyAndListening = async function popupMessageListener(msg: unknown) {
		const message = ExternalPopupMessage.parse(msg)
		if (message.method !== 'popup_confirmTransactionReadyAndListening') return
		browser.runtime.onMessage.removeListener(windowReadyAndListening)
		return sendPopupMessageToOpenWindows({ method: 'popup_update_confirm_transaction_dialog', data: (await appendPromise).map((p) => p.simulationResults) })
	}
	try {
		const activeAddress = getActiveAddressForDomain(settings.websiteAccess, website.websiteOrigin, settings)
		if (activeAddress === undefined) return ERROR_INTERCEPTOR_NO_ACTIVE_ADDRESS
		const transactionToSimulate = await transactionToSimulatePromise()
		if (transactionToSimulate === undefined) return rejectMessage

		const addedPendingTransaction = await pendingConfirmationSemaphore.execute(async () => {
			if (!justAddToPending) {
				const oldPromise = await getPendingTransactions()
				if (oldPromise.length !== 0) {
					if ((await browser.tabs.query({ windowId: oldPromise[0].dialogId })).length > 0) {
						justAddToPending = true
					} else {
						await clearPendingTransactions()
					}
				}
			}
			const refreshSimulationPromise = refreshConfirmTransactionSimulation(ethereumClientService, activeAddress, simulationMode, request.requestId, transactionToSimulate, website)

			const resolveAppendPromise = async (WindowId: number, simulationResults: ConfirmTransactionTransactionSingleVisualization) => {
				appendPromise.resolve(await appendPendingTransaction({
					website: website,
					dialogId: WindowId,
					socket: socket,
					request: request,
					transactionToSimulate: transactionToSimulate,
					simulationMode: simulationMode,
					activeAddress: activeAddress,
					simulationResults: simulationResults,
				}))
			}

			if (!justAddToPending) {
				browser.runtime.onMessage.addListener(windowReadyAndListening)
				browser.windows.onRemoved.addListener(onCloseWindow)
				openedConfirmTransactionDialogWindow = await browser.windows.create({
					url: getHtmlFile('confirmTransaction'),
					type: 'popup',
					height: 800,
					width: 600,
				})
			}
			if (openedConfirmTransactionDialogWindow === null || openedConfirmTransactionDialogWindow.id === undefined) return false
			await resolveAppendPromise(openedConfirmTransactionDialogWindow.id, await refreshSimulationPromise)
			if (justAddToPending) sendPopupMessageToOpenWindows({ method: 'popup_confirm_transaction_dialog_pending_changed', data: (await getPendingTransactions()).map((p) => p.simulationResults) })
			return true
		})
		if (addedPendingTransaction === false) return rejectMessage
		const reply = await pendingTransaction
		const resolvedPromise = await resolve(ethereumClientService, simulationMode, activeAddress, transactionToSimulate, website, reply === 'Approved' ? true : false)
		return resolvedPromise
	} finally {
		browser.windows.onRemoved.removeListener(windowReadyAndListening)
		browser.windows.onRemoved.removeListener(onCloseWindow)
		pendingTransactions.delete(request.requestId)
		updateConfirmTransactionViewWithPendingTransactionOrClose()
	}
}

async function resolve(ethereumClientService: EthereumClientService, simulationMode: boolean, activeAddress: bigint, transactionToSimulate: EthereumUnsignedTransaction, website: Website, accept: boolean) {
	if (accept === false) return rejectMessage
	if (!simulationMode) return { forward: true } as const
	const newState = await updateSimulationState(async () => {
		const simulationState = (await getSimulationResults()).simulationState
		if (simulationState === undefined) return undefined
		return await appendTransaction(ethereumClientService, simulationState, { transaction: transactionToSimulate, website: website })
	}, activeAddress)
	if (newState === undefined || newState.simulatedTransactions === undefined || newState.simulatedTransactions.length === 0) {
		return METAMASK_ERROR_NOT_CONNECTED_TO_CHAIN
	}
	return { result: bytes32String(newState.simulatedTransactions[newState.simulatedTransactions.length - 1].signedTransaction.hash) }
}
