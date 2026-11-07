import type { PopupOrTabId } from '../types/websiteAccessTypes.js'
import { reportUnexpectedError } from '../utils/errors.js'
import { closePopupOrTabById, tryFocusingTabOrWindow } from '../utils/popupOrTab.js'
import { Semaphore } from '../utils/semaphore.js'
import { getPendingTransactionsAndMessages } from './storageVariables.js'

/**
 * The lock order of the background, the one place that defines it, for every lock there is. A lock may only be taken while holding locks of an earlier rank:
 * 1. pendingRequestLimiter (background-startup.ts): admission of website requests, a count of 40 rather than an exclusive lock.
 * 2. serializeSignerAccountRequest (interceptorAccess.ts), held while waiting for a signer's reply, which is handled under the next lock.
 * 3. serializeSignerStateOperation (signerStateOwnership.ts): a signer's reply resolves its request and changes the active address under it, so it comes before every lock below.
 * 4. pendingInterceptorAccessSemaphore (interceptorAccess.ts), then changeActiveAddressAndChainSemaphore (activeSettings.ts). Neither reaches the pending-confirmation lock, which reaches neither: intercepted requests are replayed, and access updates finished, after they are released.
 * 5. pendingConfirmationSemaphore (this module).
 * 6. simulationHashSemaphore (simulationStackHashes.ts).
 * 7. The locks of one task, never two together: terminalReplySemaphore (terminalReplyDelivery.ts), inputLogSemaphore (requestResolution.ts), updateSimulationVisualisationSemaphore (popupVisualisationUpdater.ts), queueProcessingSemaphore (watchAsset.ts), updateDeclarativeNetRequestBlocksSemaphore (accessManagement.ts), publishSemaphore (rpcSlowRequestTracking.ts), runTabIconUpdate (iconHandler.ts), runFilterChangeSerially (EthereumSubscriptionService.ts).
 * 8. simulationResultsSemaphore (storageVariables.ts), whose update fetches metadata while held.
 * 9. The locks of one stored value, whose updates only compute the value, never two together: pendingTransactionsSemaphore, tabStateSemaphore, userAddressBookEntriesSemaphore, ensNodeHashesSemaphore, ensLabelHashesSemaphore and transactionStateSemaphore (storageVariables.ts), pendingTerminalRepliesSemaphore (pendingTerminalReplies.ts), signingAddressPreferencesSemaphore, makeMeRichSettingsSemaphore and websiteAccessSemaphore (settings.ts), and each stored value repository's updateSemaphore (storedValue.ts).
 * 10. The leaves, each taking nothing else: interceptorErrorDiagnosticsSemaphore (storageVariables.ts), which recovering corrupt pending terminal replies takes while holding pendingTerminalRepliesSemaphore to report it, and largeStateSemaphore (largeStateStore.ts).
 * test/tests/lockOrderBoundaries.test.ts fails on a lock this list does not name, and pins which module may take the main locks and that the locks below rank 5 cannot reach it.
 * It is not asserted at runtime: checking it needs to know which locks the current async call holds, and the extension's browser contexts have no async-context tracking, so a check would mean passing lock tokens through every call.
 * A resolution claim is not a lock: a resolution run while the pending-confirmation lock is held (the orphans of getPendingTransactionWindow) is given the lock's token (PendingConfirmationLock) and does not take it again, and scheduled retries run without it.
 */
// Serializes choosing a confirmation window and registering a request in it with deciding to close a window after its last request (updateConfirmationWindowAfterRemoving).
const pendingConfirmationSemaphore = new Semaphore(1)

// Proof of holding the pending-confirmation lock, valid only for the scope that took it: a copy that outlives that scope no longer counts, and its holder takes the lock normally.
export type PendingConfirmationLock = { held: boolean }
export const withPendingConfirmationLock = async <Result>(work: (lock: PendingConfirmationLock) => Promise<Result>) => await pendingConfirmationSemaphore.execute(async () => {
	const lock = { held: true }
	try {
		return await work(lock)
	} finally {
		lock.held = false
	}
})

// Runs one step of the confirmation window work done after a request is resolved. A failing step is reported and does not skip the steps after it, so the window is still updated and closed.
export async function runConfirmationViewStep(step: () => Promise<unknown>) {
	try {
		await step()
	} catch (error: unknown) {
		await reportUnexpectedError(error, { code: 'confirm_transaction_view_update_failed' })
	}
}

// How a window update reaches the window: refreshConfirmationWindow shows the confirmation queue in it, and is the only step that needs the simulation services.
export type ConfirmationWindowAccess = { readonly refreshConfirmationWindow: () => Promise<boolean> }
// The lock a call runs under: the token of a caller that already holds the pending-confirmation lock.
export type LockScope = { readonly pendingConfirmationLock?: PendingConfirmationLock }

// Updates the confirmation window that showed a removed request: it moves to the next of its own requests, or closes after its last. A window the user already closed counts as closed; any other failure throws, for the finishing to retry. Deciding and closing hold the pending-confirmation lock, as choosing a window and registering a new request in it do, so a request never registers in a window that is being closed: it either registers first, and the window moves to it, or chooses its window after the close and opens a new one. A caller that holds the lock (pendingConfirmationLock) does not take it again.
export async function updateConfirmationWindowAfterRemoving(confirmationWindow: PopupOrTabId, tabId: number, access: ConfirmationWindowAccess, scope: LockScope) {
	const decideAndUpdate = async () => {
		const pendingRequests = await getPendingTransactionsAndMessages()
		// Decided for this window: requests in another window never keep it open.
		if (pendingRequests.some((pending) => pending.popupOrTabId.type === confirmationWindow.type && pending.popupOrTabId.id === confirmationWindow.id)) {
			if (!(await access.refreshConfirmationWindow())) throw new Error('The confirmation window could not be moved to the next request.')
			return
		}
		// Focusing the website is view work, as on main (#1650): its failure is reported, not retried, and never keeps the window open.
		if (pendingRequests.length === 0) await runConfirmationViewStep(async () => await tryFocusingTabOrWindow({ type: 'tab', id: tabId }))
		await closePopupOrTabById(confirmationWindow)
	}
	if (scope.pendingConfirmationLock?.held === true) await decideAndUpdate()
	else await withPendingConfirmationLock(decideAndUpdate)
}
