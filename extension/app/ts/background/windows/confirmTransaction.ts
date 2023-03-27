import { bytes32String } from '../../utils/bigint.js'
import { ERROR_INTERCEPTOR_NOT_READY, ERROR_INTERCEPTOR_NO_ACTIVE_ADDRESS, METAMASK_ERROR_NOT_CONNECTED_TO_CHAIN, METAMASK_ERROR_USER_REJECTED_REQUEST } from '../../utils/constants.js'
import { Future } from '../../utils/future.js'
import { ExternalPopupMessage, InterceptedRequest } from '../../utils/interceptor-messages.js'
import { Website, WebsiteSocket } from '../../utils/user-interface-types.js'
import { EthereumUnsignedTransaction } from '../../utils/wire-types.js'
import { getActiveAddressForDomain } from '../accessManagement.js'
import { appendTransactionToSimulator, refreshConfirmTransactionSimulation, sendMessageToContentScript } from '../background.js'
import { getHtmlFile, sendPopupMessageToOpenWindows } from '../backgroundUtils.js'
import { getConfirmationWindowPromise, saveConfirmationWindowPromise } from '../settings.js'

export type Confirmation = 'Approved' | 'Rejected' | 'NoResponse'
let openedConfirmTransactionDialogWindow: browser.windows.Window | null = null
let pendingTransaction: Future<Confirmation> | undefined = undefined

export async function resolvePendingTransaction(confirmation: Confirmation) {
	if (pendingTransaction !== undefined) {
		pendingTransaction.resolve(confirmation)
	} else {
		// we have not been tracking this window, forward its message directly to content script (or signer)
		const data = await getConfirmationWindowPromise()
		if (data === undefined) return
		const resolved = await resolve(confirmation, data.simulationMode, data.transactionToSimulate, data.website)
		sendMessageToContentScript(data.socket, resolved, data.request)
	}
	openedConfirmTransactionDialogWindow = null
}

const onCloseWindow = (windowId: number) => { // check if user has closed the window on their own, if so, reject signature
	if (openedConfirmTransactionDialogWindow === null || openedConfirmTransactionDialogWindow.id !== windowId) return
	if (pendingTransaction === undefined) return
	openedConfirmTransactionDialogWindow = null
	resolvePendingTransaction('Rejected')
}

const reject = function() {
	return {
		error: {
			code: METAMASK_ERROR_USER_REJECTED_REQUEST,
			message: 'Interceptor Tx Signature: User denied transaction signature.'
		}
	}
}

export async function openConfirmTransactionDialog(
	socket: WebsiteSocket,
	request: InterceptedRequest,
	website: Website,
	simulationMode: boolean,
	transactionToSimulatePromise: () => Promise<EthereumUnsignedTransaction>,
) {
	if (pendingTransaction !== undefined) return reject() // previous window still loading
	pendingTransaction = new Future<Confirmation>()
	try {
		if (globalThis.interceptor.settings === undefined) return ERROR_INTERCEPTOR_NOT_READY

		const oldPromise = await getConfirmationWindowPromise()
		if (oldPromise !== undefined) {
			if ((await browser.tabs.query({ windowId: oldPromise.dialogId })).length > 0) {
				return reject() // previous window still open
			} else {
				await saveConfirmationWindowPromise(undefined)
			}
		}

		const activeAddress = getActiveAddressForDomain(globalThis.interceptor.settings.websiteAccess, website.websiteOrigin)
		if (activeAddress === undefined) return ERROR_INTERCEPTOR_NO_ACTIVE_ADDRESS

		if (openedConfirmTransactionDialogWindow !== null && openedConfirmTransactionDialogWindow.id) {
			browser.windows.onRemoved.removeListener(onCloseWindow)
			await browser.windows.remove(openedConfirmTransactionDialogWindow.id)
		}

		const transactionToSimulate = await transactionToSimulatePromise()

		const refreshSimulationPromise = refreshConfirmTransactionSimulation(activeAddress, simulationMode, request.requestId, transactionToSimulate, website)

		const windowReadyAndListening = async function popupMessageListener(msg: unknown) {
			const message = ExternalPopupMessage.parse(msg)
			if (message.method !== 'popup_confirmTransactionReadyAndListening') return
			browser.runtime.onMessage.removeListener(windowReadyAndListening)
			const refreshMessage = await refreshSimulationPromise
			if (openedConfirmTransactionDialogWindow !== null && openedConfirmTransactionDialogWindow.id) {
				if (refreshMessage === undefined) return await browser.windows.remove(openedConfirmTransactionDialogWindow.id)
				return sendPopupMessageToOpenWindows(refreshMessage)
			}
		}

		try {
			browser.runtime.onMessage.addListener(windowReadyAndListening)

			openedConfirmTransactionDialogWindow = await browser.windows.create({
				url: getHtmlFile('confirmTransaction'),
				type: 'popup',
				height: 600,
				width: 600,
			})

			if (openedConfirmTransactionDialogWindow === null || openedConfirmTransactionDialogWindow.id === undefined) return reject()

			saveConfirmationWindowPromise({
				website: website,
				dialogId: openedConfirmTransactionDialogWindow.id,
				socket: socket,
				request: request,
				transactionToSimulate: transactionToSimulate,
				simulationMode: simulationMode,
			})

			browser.windows.onRemoved.addListener(onCloseWindow)

			const reply = await pendingTransaction
			return await resolve(reply, simulationMode, transactionToSimulate, website)
		} finally {
			browser.windows.onRemoved.removeListener(windowReadyAndListening)
			browser.windows.onRemoved.removeListener(onCloseWindow)
		}
	} finally {
		pendingTransaction = undefined
	}
}

async function resolve(reply: Confirmation, simulationMode: boolean, transactionToSimulate: EthereumUnsignedTransaction, website: Website ) {
	await saveConfirmationWindowPromise(undefined)
	if (reply !== 'Approved') return reject()
	if (!simulationMode) return { forward: true as const }

	const appended = await appendTransactionToSimulator(transactionToSimulate, website)
	if (appended === undefined) {
		return {
			error: {
				code: METAMASK_ERROR_NOT_CONNECTED_TO_CHAIN,
				message: 'Interceptor not ready'
			}
		}
	}
	return { result: bytes32String(appended.signed.hash) }
}
