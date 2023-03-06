import { bytes32String } from '../../utils/bigint.js'
import { ERROR_INTERCEPTOR_NOT_READY, ERROR_INTERCEPTOR_NO_ACTIVE_ADDRESS, METAMASK_ERROR_NOT_CONNECTED_TO_CHAIN, METAMASK_ERROR_USER_REJECTED_REQUEST } from '../../utils/constants.js'
import { Future } from '../../utils/future.js'
import { PopupMessage } from '../../utils/interceptor-messages.js'
import { Website } from '../../utils/user-interface-types.js'
import { EthereumUnsignedTransaction } from '../../utils/wire-types.js'
import { getActiveAddressForDomain } from '../accessManagement.js'
import { appendTransactionToSimulator, refreshConfirmTransactionSimulation } from '../background.js'
import { getHtmlFile, sendPopupMessageToOpenWindows } from '../backgroundUtils.js'

export type Confirmation = 'Approved' | 'Rejected' | 'NoResponse'
let openedConfirmTransactionDialogWindow: browser.windows.Window | null = null
let pendingTransaction: Future<Confirmation> | undefined = undefined

export async function resolvePendingTransaction(confirmation: Confirmation) {
	if (pendingTransaction !== undefined) pendingTransaction.resolve(confirmation)
	pendingTransaction = undefined

	if (openedConfirmTransactionDialogWindow !== null && openedConfirmTransactionDialogWindow.id) {
		await browser.windows.remove(openedConfirmTransactionDialogWindow.id)
	}
	openedConfirmTransactionDialogWindow = null
}

const onCloseWindow = () => { // check if user has closed the window on their own, if so, reject signature
	if (pendingTransaction === undefined) return
	openedConfirmTransactionDialogWindow = null
	resolvePendingTransaction('Rejected')
	browser.windows.onRemoved.removeListener( onCloseWindow )
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
	requestId: number,
	website: Website,
	simulationMode: boolean,
	transactionToSimulatePromise: () => Promise<EthereumUnsignedTransaction>,
) {
	if (pendingTransaction !== undefined) return reject() // previous window still loading
	if (globalThis.interceptor.settings === undefined) return ERROR_INTERCEPTOR_NOT_READY

	const activeAddress = getActiveAddressForDomain(globalThis.interceptor.settings.websiteAccess, website.websiteOrigin)
	if (activeAddress === undefined) return ERROR_INTERCEPTOR_NO_ACTIVE_ADDRESS

	if (openedConfirmTransactionDialogWindow !== null && openedConfirmTransactionDialogWindow.id) {
		browser.windows.onRemoved.removeListener( onCloseWindow )
		await browser.windows.remove(openedConfirmTransactionDialogWindow.id)
	}

	const transactionToSimulate = await transactionToSimulatePromise()

	const refreshSimulationPromise = refreshConfirmTransactionSimulation(activeAddress, simulationMode, requestId, transactionToSimulate, website)

	const windowReadyAndListening = async function popupMessageListener(msg: unknown) {
		const message = PopupMessage.parse(msg)
		if ( message.method !== 'popup_confirmTransactionReadyAndListening') return
		browser.runtime.onMessage.removeListener(windowReadyAndListening)
		const refreshMessage = await refreshSimulationPromise
		if (openedConfirmTransactionDialogWindow !== null && openedConfirmTransactionDialogWindow.id) {
			if (refreshMessage === undefined) return await browser.windows.remove(openedConfirmTransactionDialogWindow.id)
			return sendPopupMessageToOpenWindows(refreshMessage)
		}
	}

	browser.runtime.onMessage.addListener(windowReadyAndListening)
	pendingTransaction = new Future<Confirmation>()

	openedConfirmTransactionDialogWindow = await browser.windows.create(
		{
			url: getHtmlFile('confirmTransaction'),
			type: 'popup',
			height: 600,
			width: 600,
		}
	)

	if (openedConfirmTransactionDialogWindow === null) return reject()

	browser.windows.onRemoved.addListener(onCloseWindow)

	const reply = await pendingTransaction

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
