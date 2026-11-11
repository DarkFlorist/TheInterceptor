import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { TokenPriceService } from '../simulation/services/priceEstimator.js'
import type { PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import type { InterceptedRequestForward } from '../types/interceptor-messages.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { SimulationStackChange } from '../types/visualizer-types.js'
import { reportUnexpectedError } from '../utils/errors.js'
import { closePopupOrTabById, openPopupOrTab, getPopupOrTabById, tryFocusingTabOrWindow } from '../utils/popupOrTab.js'
import { assertNever } from '../utils/typescript.js'
import { getHtmlFile } from './backgroundUtils.js'
import { updateConfirmTransactionView } from './confirmationDialogUpdates.js'
import { updatePopupVisualisationIfNeeded } from './popupVisualisationUpdater.js'
import { getPendingTransactionsAndMessages } from './storageVariables.js'
import { attemptQueuedTerminalReplyDelivery, queueTerminalReply } from './terminalReplyDelivery.js'

// The lifecycle of the confirmation window: opening the window that shows the queue, answering a request as it leaves the queue, and focusing the website or closing the window once it left.

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

// Shows a proposal that was just stored in the Gnosis Safe stack: the simulation is refreshed with it and the simulation stack window opens, where the user continues with the proposal.
async function showStoredSafeProposal(ethereum: EthereumClientService, tokenPriceService: TokenPriceService) {
	await updatePopupVisualisationIfNeeded(ethereum, tokenPriceService, { invalidateOldState: true })
	await openPopupOrTab({ url: getHtmlFile('simulationStack') })
}

// Shows how resolving a request changed the simulation stack. Every outcome is handled here, so a new outcome fails typecheck until it is given its view work.
async function showSimulationStackChange(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, simulationStack: SimulationStackChange) {
	switch (simulationStack) {
		case 'unchanged': return
		case 'changed': {
			await updatePopupVisualisationIfNeeded(ethereum, tokenPriceService)
			return
		}
		case 'safeProposalStored': {
			await showStoredSafeProposal(ethereum, tokenPriceService)
			return
		}
		default: assertNever(simulationStack)
	}
}

// The error code a failing view step is reported with, which tells wallet_sendCalls batches apart from the other requests in error reports.
const getConfirmationViewFailureCode = (removedRequest: PendingTransactionOrSignableMessage) => removedRequest.type === 'TransactionBatch'
	? 'wallet_send_calls_confirmation_view_update_failed'
	: 'confirm_transaction_view_update_failed'

// Runs one step of the confirmation window work done after a request is resolved. A failing step is reported and does not skip the steps after it, so the window is still updated and closed.
async function runConfirmationViewStep(removedRequest: PendingTransactionOrSignableMessage, step: () => Promise<unknown>) {
	try {
		await step()
	} catch (error: unknown) {
		await reportUnexpectedError(error, { code: getConfirmationViewFailureCode(removedRequest) })
	}
}

// Updates the confirmation window once a request has left the confirmation queue: the view of how the simulation stack changed, and the queue view, which focuses the website's tab once the queue is empty and closes the window once no pending request is shown in it. The website's answer never waits for this view work, so a failure in it is reported instead of reaching the caller.
export async function updateViewAfterPendingRequestRemoved(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, removedRequest: PendingTransactionOrSignableMessage, simulationStack: SimulationStackChange) {
	const removedRequestWindow = removedRequest.popupOrTabId
	await runConfirmationViewStep(removedRequest, async () => await showSimulationStackChange(ethereum, tokenPriceService, simulationStack))
	await runConfirmationViewStep(removedRequest, async () => {
		if ((await getPendingTransactionsAndMessages()).length === 0) await tryFocusingTabOrWindow({ type: 'tab', id: removedRequest.uniqueRequestIdentifier.requestSocket.tabId })
	})
	await runConfirmationViewStep(removedRequest, async () => {
		const confirmationQueueIsShown = await updateConfirmTransactionView(ethereum, tokenPriceService)
		// The website may send its next request as soon as it has this answer. Arriving while the queue is empty, that request opens a window of its own, so this window is closed once no pending request is shown in it rather than only once the queue is empty.
		const windowShowsAPendingRequest = (await getPendingTransactionsAndMessages()).some((pending) => pending.popupOrTabId.type === removedRequestWindow.type && pending.popupOrTabId.id === removedRequestWindow.id)
		if (!confirmationQueueIsShown || !windowShowsAPendingRequest) await closePopupOrTabById(removedRequestWindow)
	})
}

// How a request leaves the confirmation queue with its terminal reply: the request, the reply, the storage write that removes the request, and how that resolution changed the simulation stack.
export type PendingRequestRemoval = {
	readonly removedRequest: PendingTransactionOrSignableMessage
	readonly terminalReply: InterceptedRequestForward
	readonly removeFromQueue: () => Promise<void>
	readonly simulationStack: SimulationStackChange
}

// Every resolution that answers the website with a terminal reply takes this order. The reply is queued before the request leaves the confirmation queue, so after a restart at most its delivery is left. The request is removed, together with anything its removal releases, such as a wallet_sendCalls batch id, before the reply is delivered, so a website acting on the reply finds the request gone. The reply is delivered before the window work, which cannot hold it back, and the window is updated even when delivery throws, after which the delivery error reaches the caller.
export async function removePendingRequestAndDeliverTerminalReply(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, websiteTabConnections: WebsiteTabConnections, removal: PendingRequestRemoval) {
	await queueTerminalReply(removal.terminalReply)
	await removal.removeFromQueue()
	try {
		return await attemptQueuedTerminalReplyDelivery(websiteTabConnections, removal.terminalReply)
	} finally {
		await updateViewAfterPendingRequestRemoved(ethereum, tokenPriceService, removal.removedRequest, removal.simulationStack)
	}
}
