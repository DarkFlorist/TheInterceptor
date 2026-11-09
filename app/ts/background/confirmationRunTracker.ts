// Orders the confirmation runs of each pending request and tracks the one in flight, with one tracker per request. Runs are only ever compared with runs of the same request, so the state is kept per request: a tracker is created by the request's first reservation and disposed when the request leaves the confirmation queue.
import type { ConfirmationRunId } from '../types/accessRequest.js'
import { NEW_BLOCK_ABORT } from '../utils/constants.js'
import { getUniqueRequestIdentifierString, type UniqueRequestIdentifier } from '../utils/requests.js'

type InFlightConfirmationRun = { readonly sequence: number, readonly abortController: AbortController }

// lifetime is a random id of this tracker, so a run of a tracker that was disposed, or of a background that restarted, never takes the id of a run of a later tracker of the same request.
type ConfirmationRunTracker = {
	readonly lifetime: string
	readonly latestSequence: number
	readonly inFlight: InFlightConfirmationRun | undefined
}

export function createConfirmationRunTrackers(createLifetime: () => string = () => crypto.randomUUID()) {
	const trackers = new Map<string, ConfirmationRunTracker>()
	const lookup = (uniqueRequestIdentifier: UniqueRequestIdentifier) => trackers.get(getUniqueRequestIdentifierString(uniqueRequestIdentifier))
	const lookupOrCreate = (uniqueRequestIdentifier: UniqueRequestIdentifier) => lookup(uniqueRequestIdentifier) ?? { lifetime: createLifetime(), latestSequence: 0, inFlight: undefined }
	const store = (uniqueRequestIdentifier: UniqueRequestIdentifier, tracker: ConfirmationRunTracker) => trackers.set(getUniqueRequestIdentifierString(uniqueRequestIdentifier), tracker)
	return {
		// Reserves the request's next run id synchronously, so every entry that starts a confirmation run calls it before its first await once it knows the request, and a run that starts first gets the earlier id. A reservation that its entry ends up not using only skips a sequence number. It reads neither storage nor the clock, so it cannot fail.
		reserve: (uniqueRequestIdentifier: UniqueRequestIdentifier): ConfirmationRunId => {
			const tracker = lookupOrCreate(uniqueRequestIdentifier)
			const sequence = tracker.latestSequence + 1
			store(uniqueRequestIdentifier, { ...tracker, latestSequence: sequence })
			return { lifetime: tracker.lifetime, sequence }
		},
		// Makes the run the request's run in flight and aborts the one it replaces. A run that starts after a later run of its request is already in flight does not start, so an earlier run never aborts a later one, and runs of different requests never cancel each other.
		startRun: (uniqueRequestIdentifier: UniqueRequestIdentifier, run: ConfirmationRunId): AbortController | undefined => {
			const tracker = lookupOrCreate(uniqueRequestIdentifier)
			if (tracker.inFlight !== undefined && tracker.inFlight.sequence > run.sequence) return undefined
			tracker.inFlight?.abortController.abort(NEW_BLOCK_ABORT)
			const inFlight = { sequence: run.sequence, abortController: new AbortController() }
			store(uniqueRequestIdentifier, { ...tracker, inFlight })
			return inFlight.abortController
		},
		// Ends the run in flight, unless a later run replaced it already.
		finishRun: (uniqueRequestIdentifier: UniqueRequestIdentifier, abortController: AbortController) => {
			const tracker = lookup(uniqueRequestIdentifier)
			if (tracker?.inFlight?.abortController === abortController) store(uniqueRequestIdentifier, { ...tracker, inFlight: undefined })
		},
		// The abort controller of the request's run in flight, if any, for work that is outdated once a later run of that request starts.
		getInFlightAbortController: (uniqueRequestIdentifier: UniqueRequestIdentifier) => lookup(uniqueRequestIdentifier)?.inFlight?.abortController,
		// Called when the request leaves the confirmation queue. A run still in flight finds no request to store onto, so it is left to end by itself.
		dispose: (uniqueRequestIdentifier: UniqueRequestIdentifier) => {
			trackers.delete(getUniqueRequestIdentifierString(uniqueRequestIdentifier))
		},
	}
}

export type ConfirmationRunTrackers = ReturnType<typeof createConfirmationRunTrackers>

// The background's trackers.
export const confirmationRuns = createConfirmationRunTrackers()
