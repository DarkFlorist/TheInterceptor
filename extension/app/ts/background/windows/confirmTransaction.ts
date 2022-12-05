import { bytes32String } from "../../utils/bigint"
import { METAMASK_ERROR_NOT_CONNECTED_TO_CHAIN, METAMASK_ERROR_USER_REJECTED_REQUEST } from "../../utils/constants"
import { Future } from "../../utils/future"
import { InterceptedRequest } from "../../utils/interceptor-messages"
import { EthereumUnsignedTransaction } from "../../utils/wire-types"
import { getActiveAddressForDomain } from "../accessManagement"
import { appendTransactionToSimulator, refreshConfirmTransactionSimulation } from "../background"

export type Confirmation = 'Approved' | 'Rejected' | 'NoResponse'
let openedConfirmTransactionDialogWindow: browser.windows.Window | null = null
let pendingTransaction: Future<Confirmation> | undefined = undefined

export async function resolvePendingTransaction(confirmation: Confirmation) {
	if (pendingTransaction !== undefined) pendingTransaction.resolve(confirmation)
	pendingTransaction = undefined

	if (openedConfirmTransactionDialogWindow !== null && openedConfirmTransactionDialogWindow.id) {
		await browser.windows.remove(openedConfirmTransactionDialogWindow.id)
	}
	window.interceptor.confirmTransactionDialog = undefined
	openedConfirmTransactionDialogWindow = null
}

const onCloseWindow = () => { // check if user has closed the window on their own, if so, reject signature
	if (pendingTransaction === undefined) return
	window.interceptor.confirmTransactionDialog = undefined
	openedConfirmTransactionDialogWindow = null
	resolvePendingTransaction('Rejected')
	browser.windows.onRemoved.removeListener( onCloseWindow )
}

export async function openConfirmTransactionDialog(
	port: browser.runtime.Port,
	request: InterceptedRequest,
	simulationMode: boolean,
	transactionToSimulatePromise: () => Promise<EthereumUnsignedTransaction>,
) {
	if (window.interceptor.settings === undefined) return
	if (port.sender?.url === undefined) return

	const activeAddress = getActiveAddressForDomain(window.interceptor.settings.websiteAccess, (new URL(port.sender.url)).hostname)
	if (activeAddress === undefined) return

	const reject = function() {
		return port.postMessage({
			interceptorApproved: false,
			requestId: request.requestId,
			options: request.options,
			error: {
				code: METAMASK_ERROR_USER_REJECTED_REQUEST,
				message: 'Interceptor Tx Signature: User denied transaction signature.'
			}
		})
	}

	if (window.interceptor.confirmTransactionDialog !== undefined
		&& window.interceptor.confirmTransactionDialog.visualizerResults === undefined) return reject() // previous window still loading

	window.interceptor.confirmTransactionDialog = {
		requestToConfirm: request,
		addressMetadata: [],
		visualizerResults: undefined,
		simulationState: undefined,
		simulationMode: simulationMode,
		tokenPrices: [],
		activeAddress: activeAddress,
		transactionToSimulate: undefined,
		isComputingSimulation: false,
	}

	if (openedConfirmTransactionDialogWindow !== null && openedConfirmTransactionDialogWindow.id) {
		browser.windows.onRemoved.removeListener( onCloseWindow )
		await browser.windows.remove(openedConfirmTransactionDialogWindow.id)
	}

	openedConfirmTransactionDialogWindow = await browser.windows.create(
		{
			url: '../html/confirmTransaction.html',
			type: 'popup',
			height: 400,
			width: 520,
		}
	)

	if (openedConfirmTransactionDialogWindow === null) return reject()

	pendingTransaction = new Future<Confirmation>()
	browser.windows.onRemoved.addListener(onCloseWindow)

	const transactionToSimulate = await transactionToSimulatePromise()
	if (window.interceptor.confirmTransactionDialog === undefined) return reject() // user already closed the window

	window.interceptor.confirmTransactionDialog.transactionToSimulate = EthereumUnsignedTransaction.serialize(transactionToSimulate)
	await refreshConfirmTransactionSimulation()

	const reply = await pendingTransaction

	// forward message to content script
	if(reply === 'Approved') {
		if (simulationMode) {
			const appended = await appendTransactionToSimulator(transactionToSimulate)
			if (appended === undefined) {
				return port.postMessage({
					interceptorApproved: false,
					requestId: request.requestId,
					options: request.options,
					error: {
						code: METAMASK_ERROR_NOT_CONNECTED_TO_CHAIN,
						message: 'Interceptor not ready'
					}
				})
			}
			return port.postMessage({
				interceptorApproved: true,
				requestId: request.requestId,
				options: request.options,
				result: bytes32String(appended.signed.hash)
			})
		}
		return port.postMessage({
			interceptorApproved: true,
			requestId: request.requestId,
			options: request.options
		})
	}
	return reject()
}
