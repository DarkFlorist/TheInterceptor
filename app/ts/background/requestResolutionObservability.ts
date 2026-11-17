import { resolutionState } from './requestResolutionState.js'
import { resetResolutionInputs, getResolutionInputBookkeepingSize } from './requestResolutionInputs.js'
import { resetResolutionLifecycle, getResolutionLifecycleActivitySize, getResolutionLifecycleBookkeepingSize } from './requestResolutionLifecycle.js'

// Test observability only: drops all working state and its scheduled retries, as a restart does; the stored requests and replies stay.
export const resetResolutionState = () => {
	resolutionState.claims.clear()
	resolutionState.deferredResolutions.clear()
	resolutionState.chosenReplies.clear()
	resetResolutionInputs()
	resolutionState.requestRetries.resetAll()
	resetResolutionLifecycle()
}
// Test observability only: the size of the in-memory resolution activity: claims held, follow-ups deferred and retries scheduled (of requests and of bounded work), which is empty whenever no resolution is in flight or awaiting a retry. Intent kept for a later user action or startup (chosen replies, recorded inputs, exhausted budgets) is not activity.
export const getResolutionActivitySize = () => resolutionState.claims.size + resolutionState.deferredResolutions.size + resolutionState.requestRetries.getScheduledRetryCount() + getResolutionLifecycleActivitySize()
// Test observability only: the size of all the working state, activity and kept intent alike.
export const getResolutionBookkeepingSize = () => resolutionState.claims.size + resolutionState.deferredResolutions.size + resolutionState.chosenReplies.size + getResolutionInputBookkeepingSize() + resolutionState.requestRetries.getTrackedKeyCount() + getResolutionLifecycleBookkeepingSize()
