import { Future } from '../../utils/future.js'
import { doesUniqueRequestIdentifiersMatch, type UniqueRequestIdentifier } from '../../utils/requests.js'

// The in-memory reply a dialog waits for, bound to the one request it answers. The future stays inside the closure, so a value only reaches it through tryResolve naming that request
export type PendingDialogReply<T> = {
	readonly uniqueRequestIdentifier: UniqueRequestIdentifier
	readonly reply: Promise<T>
	readonly tryResolve: (uniqueRequestIdentifier: UniqueRequestIdentifier, value: T) => boolean
}

// A confirmation can outlive its dialog (a slow snapshot, or a dialog left open by a background restart), so a value naming any other request is ignored and the waiting request keeps waiting for its own answer
export function createPendingDialogReply<T>(uniqueRequestIdentifier: UniqueRequestIdentifier): PendingDialogReply<T> {
	const future = new Future<T>()
	return {
		uniqueRequestIdentifier,
		reply: future.asPromise,
		tryResolve: (answeredRequestIdentifier, value) => {
			if (!doesUniqueRequestIdentifiersMatch(answeredRequestIdentifier, uniqueRequestIdentifier)) return false
			future.resolve(value)
			return true
		},
	}
}
