// The one way an entry point takes confirmation runs: it reserves them before its first await, runs its work with them, and afterwards, whether the work returned or threw, disposes of the tracker of every request among them that is not stored, so a request that was reserved for but never stored, or left the queue meanwhile, leaves no tracker behind. A stored request's tracker is disposed by removePendingTransactionOrMessage when it leaves the queue.
import type { ConfirmationRunId } from '../types/accessRequest.js'
import { doesUniqueRequestIdentifiersMatch, type UniqueRequestIdentifier } from '../utils/requests.js'
import { confirmationRuns, type ConfirmationRunTrackers } from './confirmationRunTracker.js'
import { buildFromPendingTransactionsAndMessages } from './storageVariables.js'

// Runs dispose if the request is not stored, deciding that under the lock of the queue's writers, so an append of the request is not missed.
export type DisposeIfRequestGone = (uniqueRequestIdentifier: UniqueRequestIdentifier, dispose: () => void) => Promise<void>

export function createConfirmationRunLifecycle(trackers: ConfirmationRunTrackers, disposeIfRequestGone: DisposeIfRequestGone) {
	const release = async (uniqueRequestIdentifiers: readonly UniqueRequestIdentifier[]) => {
		for (const uniqueRequestIdentifier of uniqueRequestIdentifiers) await disposeIfRequestGone(uniqueRequestIdentifier, () => trackers.dispose(uniqueRequestIdentifier))
	}
	// Reserves one run of each request synchronously, when called, so a caller that calls it before its first await orders its runs from when it started.
	const withConfirmationRuns = async <T>(uniqueRequestIdentifiers: readonly UniqueRequestIdentifier[], work: (runs: readonly ConfirmationRunId[]) => Promise<T>): Promise<T> => {
		const runs = uniqueRequestIdentifiers.map((uniqueRequestIdentifier) => trackers.reserve(uniqueRequestIdentifier))
		try {
			return await work(runs)
		} finally {
			await release(uniqueRequestIdentifiers)
		}
	}
	const withConfirmationRun = async <T>(uniqueRequestIdentifier: UniqueRequestIdentifier, work: (run: ConfirmationRunId) => Promise<T>): Promise<T> => await withConfirmationRuns([uniqueRequestIdentifier], async ([run]) => {
		if (run === undefined) throw new Error('A confirmation run was not reserved')
		return await work(run)
	})
	return { withConfirmationRun, withConfirmationRuns }
}

const disposeIfStoredQueueLacksRequest: DisposeIfRequestGone = async (uniqueRequestIdentifier, dispose) => await buildFromPendingTransactionsAndMessages(async (pending) => {
	if (!pending.some((stored) => doesUniqueRequestIdentifiersMatch(stored.uniqueRequestIdentifier, uniqueRequestIdentifier))) dispose()
})

// The background's lifecycle of its confirmation runs.
export const { withConfirmationRun, withConfirmationRuns } = createConfirmationRunLifecycle(confirmationRuns, disposeIfStoredQueueLacksRequest)
