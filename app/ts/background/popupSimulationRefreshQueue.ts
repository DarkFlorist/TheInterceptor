// Coalesce interactive requests only; popupVisualisationUpdater owns execution, cancellation and stored state. See docs/popup-simulation-refresh.md.
import { Future } from '../utils/future.js'
import type { SimulationServices } from '../simulation/serviceLifecycle.js'
import { backgroundTaskSupervisor } from './backgroundTasks.js'
import { preparePopupVisualisationRefresh, type PopupVisualisationRefreshRequest } from './popupVisualisationUpdater.js'

export type PopupSimulationRefresh = SimulationServices & { readonly invalidateOldState?: boolean }

export type PopupSimulationRefreshOutcome = { readonly status: 'superseded' } | { readonly status: 'observed', readonly available: boolean }

// An observed result describes stored availability after an attempt, not which request published it. The queue owns the invalidation merged across coalesced requests and passes it to execute; requests carry none of their own.
export function createPopupSimulationRefresher() {
	type Entry = { readonly request: PopupVisualisationRefreshRequest, readonly invalidateOldState: boolean, readonly result: Future<PopupSimulationRefreshOutcome> }
	let pending: Entry | undefined
	let active: Entry | undefined
	let draining = false

	const drain = async () => {
		while (pending !== undefined) {
			const entry = pending
			pending = undefined
			active = entry
			// Settle only this entry, including thrown failures, then continue with independently queued work.
			await Promise.resolve().then(() => entry.request.execute(entry.invalidateOldState)).then(
				value => { active = undefined; entry.result.resolve({ status: 'observed', available: value }) },
				error => { active = undefined; entry.result.reject(error) },
			)
		}
		draining = false
	}

	return (request: PopupVisualisationRefreshRequest, invalidateOldState: boolean): Promise<PopupSimulationRefreshOutcome> => {
		if (pending !== undefined && pending.request.coalescingKey === request.coalescingKey) {
			pending = { ...pending, request, invalidateOldState: invalidateOldState || pending.invalidateOldState }
			return pending.result.asPromise
		}
		// In A → B → A, the last A must replace pending B rather than join the active A.
		if (pending === undefined && active !== undefined && active.request.coalescingKey === request.coalescingKey
			&& (!invalidateOldState || active.invalidateOldState)) return active.result.asPromise
		const entry: Entry = {
			request,
			invalidateOldState: invalidateOldState || (pending?.invalidateOldState ?? false),
			result: new Future<PopupSimulationRefreshOutcome>(),
		}
		pending?.result.resolve({ status: 'superseded' })
		pending = entry
		if (!draining) {
			draining = true
			void Promise.resolve().then(drain)
		}
		return entry.result.asPromise
	}
}

const refreshQueue = createPopupSimulationRefresher()

// Awaits the refresh and returns its outcome; failures reject to the caller. Use startPopupSimulationRefreshInBackground when the caller must not wait for RPC work.
export async function runPopupSimulationRefresh({ invalidateOldState = false, ...services }: PopupSimulationRefresh): Promise<PopupSimulationRefreshOutcome> {
	const request = await preparePopupVisualisationRefresh(services, invalidateOldState)
	return request === undefined ? { status: 'superseded' } : await refreshQueue(request, invalidateOldState)
}

// Awaits only local invalidation and capture, then returns without an outcome; the refresh runs as a background task that reports its own failures. Callers that need the outcome use runPopupSimulationRefresh.
export async function startPopupSimulationRefreshInBackground({ invalidateOldState = true, ...services }: PopupSimulationRefresh): Promise<void> {
	const request = await preparePopupVisualisationRefresh(services, invalidateOldState, true)
	if (request === undefined) return
	backgroundTaskSupervisor.start({ source: 'popup_simulation_refresh' }, async () => await refreshQueue(request, invalidateOldState))
}
