import { bytes32String } from '../../utils/bigint.js'
import { METAMASK_ERROR_NOT_CONNECTED_TO_CHAIN, METAMASK_ERROR_USER_REJECTED_REQUEST } from '../../utils/constants.js'
import { Future } from '../../utils/future.js'
import { EthereumUnsignedTransaction } from '../../utils/wire-types.js'
import { getActiveAddressForDomain } from '../accessManagement.js'
import { appendTransactionToSimulator, refreshConfirmTransactionSimulation } from '../background.js'

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
	requestId: number,
	origin: string,
	simulationMode: boolean,
	transactionToSimulatePromise: () => Promise<EthereumUnsignedTransaction>,
) {
	if (window.interceptor.settings === undefined) {
		return {
			error: {
				code: 1,
				message: 'Interceptor not ready'
			}
		}
	}

	const activeAddress = getActiveAddressForDomain(window.interceptor.settings.websiteAccess, (new URL(origin)).hostname)
	if (activeAddress === undefined) {
		return {
			error: {
				code: 1,
				message: 'No active address'
			}
		}
	}

	const reject = function() {
		return {
			error: {
				code: METAMASK_ERROR_USER_REJECTED_REQUEST,
				message: 'Interceptor Tx Signature: User denied transaction signature.'
			}
		}
	}

	if (window.interceptor.confirmTransactionDialog !== undefined
		&& window.interceptor.confirmTransactionDialog.visualizerResults === undefined) return reject() // previous window still loading

	window.interceptor.confirmTransactionDialog = {
		requestId: requestId,
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
				return {
					error: {
						code: METAMASK_ERROR_NOT_CONNECTED_TO_CHAIN,
						message: 'Interceptor not ready'
					}
				}
			}
			return { result: bytes32String(appended.signed.hash) }
		}
		return { forward: true as const }
	}
	return reject()
}
