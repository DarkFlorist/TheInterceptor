import type { PopupOrTabId } from '../types/websiteAccessTypes.js'
import { reportUnexpectedError } from '../utils/errors.js'
import { closePopupOrTabById, tryFocusingTabOrWindow } from '../utils/popupOrTab.js'
import { Semaphore } from '../utils/semaphore.js'
import { getPendingTransactionsAndMessages } from './storageVariables.js'

// Serializes choosing a confirmation window and registering a request in it with deciding to close a window after its last request (updateConfirmationWindowAfterRemoving). Lock order: this lock, then the hash lock (simulationStackHashes.ts), then the terminal-reply lock (terminalReplyDelivery.ts), then the storage locks. A resolution claim is not a lock: a resolution run while this lock is held (the orphans of getPendingTransactionWindow) is told so and does not take it again, and scheduled retries run without it.
const pendingConfirmationSemaphore = new Semaphore(1)

export const withPendingConfirmationLock = async <Result>(work: () => Promise<Result>) => await pendingConfirmationSemaphore.execute(work)

// Runs one step of the confirmation window work done after a request is resolved. A failing step is reported and does not skip the steps after it, so the window is still updated and closed.
export async function runConfirmationViewStep(step: () => Promise<unknown>) {
	try {
		await step()
	} catch (error: unknown) {
		await reportUnexpectedError(error, { code: 'confirm_transaction_view_update_failed' })
	}
}

// How a window update reaches the window: refreshConfirmationWindow shows the confirmation queue in it, and is the only step that needs the simulation services; holdsPendingConfirmationLock tells that the caller already holds the pending-confirmation lock.
export type ConfirmationWindowAccess = { readonly refreshConfirmationWindow: () => Promise<boolean>, readonly holdsPendingConfirmationLock?: true }

// Updates the confirmation window that showed a removed request: it moves to the next of its own requests, or closes after its last. A window the user already closed counts as closed; any other failure throws, for the finishing to retry. Deciding and closing hold the pending-confirmation lock, as choosing a window and registering a new request in it do, so a request never registers in a window that is being closed: it either registers first, and the window moves to it, or chooses its window after the close and opens a new one. A caller that holds the lock (holdsPendingConfirmationLock) does not take it again.
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
	if (access.holdsPendingConfirmationLock === true) await decideAndUpdate()
	else await withPendingConfirmationLock(decideAndUpdate)
}
