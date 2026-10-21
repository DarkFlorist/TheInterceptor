import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { TokenPriceService } from '../simulation/services/priceEstimator.js'
import type { PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import { closePopupOrTabById, openPopupOrTab, getPopupOrTabById, tryFocusingTabOrWindow } from '../utils/popupOrTab.js'
import { getHtmlFile } from './backgroundUtils.js'
import { updateConfirmTransactionView } from './confirmationDialogUpdates.js'
import { getPendingTransactionsAndMessages } from './storageVariables.js'

// The lifecycle of the confirmation window: opening the window that shows the queue, and focusing the website or closing the window once a request left the queue.

// Answers the requests of a confirmation window that was closed. windows/confirmTransaction.ts provides it, because answering a request dispatches on its kind, wallet_sendCalls batches included.
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

export async function updateViewAfterPendingRequestRemoved(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, pending: PendingTransactionOrSignableMessage) {
	if ((await getPendingTransactionsAndMessages()).length === 0) await tryFocusingTabOrWindow({ type: 'tab', id: pending.uniqueRequestIdentifier.requestSocket.tabId })
	if (!(await updateConfirmTransactionView(ethereum, tokenPriceService))) await closePopupOrTabById(pending.popupOrTabId)
}
