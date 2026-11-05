import type { PopupOrTabId } from '../types/websiteAccessTypes.js'
import { reportUnexpectedError } from '../utils/errors.js'
import { closePopupOrTabById, tryFocusingTabOrWindow } from '../utils/popupOrTab.js'
import { Semaphore } from '../utils/semaphore.js'
import { getPendingTransactionsAndMessages } from './storageVariables.js'

/**
 * The lock order of the background, the one place that defines it. A lock may only be taken while holding locks earlier in this list:
 * 1. the pending-confirmation lock (this module);
 * 2. the simulation hash lock (simulationStackHashes.ts);
 * 3. the terminal-reply lock (terminalReplyDelivery.ts) or the input-log lock (requestResolution.ts), which are never held together;
 * 4. the storage locks (storageVariables.ts), which take no other lock.
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

// How a window update reaches the window: refreshConfirmationWindow shows the confirmation queue in it, and is the only step that needs the simulation services; pendingConfirmationLock is the token of a caller that already holds the pending-confirmation lock.
export type ConfirmationWindowAccess = { readonly refreshConfirmationWindow: () => Promise<boolean>, readonly pendingConfirmationLock?: PendingConfirmationLock }

// Updates the confirmation window that showed a removed request: it moves to the next of its own requests, or closes after its last. A window the user already closed counts as closed; any other failure throws, for the finishing to retry. Deciding and closing hold the pending-confirmation lock, as choosing a window and registering a new request in it do, so a request never registers in a window that is being closed: it either registers first, and the window moves to it, or chooses its window after the close and opens a new one. A caller that holds the lock (pendingConfirmationLock) does not take it again.
export async function updateConfirmationWindowAfterRemoving(confirmationWindow: PopupOrTabId, tabId: number, access: ConfirmationWindowAccess) {
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
	if (access.pendingConfirmationLock?.held === true) await decideAndUpdate()
	else await withPendingConfirmationLock(decideAndUpdate)
}
