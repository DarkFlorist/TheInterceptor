import { isRpcConfigurationUnavailableError } from '../utils/rpcConfigurationError.js'
// Owns coalescing and supersession of interactive refreshes: which requests are equivalent, which is pending, and the invalidation merged across them. popupVisualisationUpdater owns execution, the publication generation guard, cancellation and stored state. See docs/popup-simulation-refresh.md.
import { Future } from '../utils/future.js'
import { stringifyJSONWithBigInts } from '../utils/bigint.js'
import type { SimulationServices } from '../simulation/serviceLifecycle.js'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { TokenPriceService } from '../simulation/services/priceEstimator.js'
import { backgroundTaskSupervisor } from './backgroundTasks.js'
import { preparePopupVisualisationRefresh, type PopupVisualisationRefreshTarget } from './popupVisualisationUpdater.js'

export type PopupSimulationRefresh = SimulationServices & { readonly invalidateOldState?: boolean }

export type PopupSimulationRefreshOutcome = { readonly status: 'superseded' } | { readonly status: 'observed', readonly available: boolean }

// One opaque token per installed service pair, so the queue compares service pairs without holding them in queued entries.
export type PopupSimulationServicesToken = symbol

// What the queue receives for each request: the updater's execute closure and, when the request can be compared at all, the service pair's token with a plain-data description of what it would compute.
export type QueuedPopupSimulationRefresh<Target> = {
	readonly target: { readonly servicesToken: PopupSimulationServicesToken, readonly description: Target } | undefined
	readonly execute: (invalidateOldState: boolean) => Promise<boolean>
}

// An observed result describes stored availability after an attempt, not which request published it. Requests are equivalent only for the same service pair and an equal defined target; the queue merges invalidation across equivalent requests and passes it to execute.
export function createPopupSimulationRefresher<Target>() {
	const servicesTokens = new WeakMap<EthereumClientService, WeakMap<TokenPriceService, PopupSimulationServicesToken>>()
	const identify = ({ ethereum, tokenPriceService }: SimulationServices): PopupSimulationServicesToken => {
		const byTokenPriceService = servicesTokens.get(ethereum) ?? new WeakMap<TokenPriceService, PopupSimulationServicesToken>()
		servicesTokens.set(ethereum, byTokenPriceService)
		const existing = byTokenPriceService.get(tokenPriceService)
		if (existing !== undefined) return existing
		const token = Symbol('popup simulation services')
		byTokenPriceService.set(tokenPriceService, token)
		return token
	}

	type Entry = { readonly request: QueuedPopupSimulationRefresh<Target>, readonly targetKey: string | undefined, readonly invalidateOldState: boolean, readonly result: Future<PopupSimulationRefreshOutcome> }
	const isEquivalent = (entry: Entry, request: QueuedPopupSimulationRefresh<Target>, targetKey: string | undefined) =>
		targetKey !== undefined && entry.targetKey === targetKey && entry.request.target?.servicesToken === request.target?.servicesToken
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

	const refresh = (request: QueuedPopupSimulationRefresh<Target>, invalidateOldState: boolean): Promise<PopupSimulationRefreshOutcome> => {
		const targetKey = request.target === undefined ? undefined : stringifyJSONWithBigInts(request.target.description)
		if (pending !== undefined && isEquivalent(pending, request, targetKey)) {
			pending = { ...pending, request, invalidateOldState: invalidateOldState || pending.invalidateOldState }
			return pending.result.asPromise
		}
		// In A → B → A, the last A must replace pending B rather than join the active A.
		if (pending === undefined && active !== undefined && isEquivalent(active, request, targetKey)
			&& (!invalidateOldState || active.invalidateOldState)) return active.result.asPromise
		const entry: Entry = {
			request,
			targetKey,
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

	// Identifies the service pair only for a request that has a description, because only those can be equivalent to another request.
	const toQueued = (services: SimulationServices, { target, execute }: { readonly target: Target | undefined, readonly execute: QueuedPopupSimulationRefresh<Target>['execute'] }): QueuedPopupSimulationRefresh<Target> => ({
		target: target === undefined ? undefined : { servicesToken: identify(services), description: target },
		execute,
	})

	return { identify, refresh, toQueued }
}

const refreshQueue = createPopupSimulationRefresher<PopupVisualisationRefreshTarget>()

// Awaits the refresh and returns its outcome; failures reject to the caller. Use startPopupSimulationRefreshInBackground when the caller must not wait for RPC work.
export async function runPopupSimulationRefresh({ invalidateOldState = false, ...services }: PopupSimulationRefresh): Promise<PopupSimulationRefreshOutcome> {
	const request = await preparePopupVisualisationRefresh(services, invalidateOldState)
	if (request === undefined) return { status: 'superseded' }
	return await refreshQueue.refresh(refreshQueue.toQueued(services, request), invalidateOldState)
}

// Awaits only local invalidation and capture, then returns without an outcome; the refresh runs as a background task that reports its own failures. Callers that need the outcome use runPopupSimulationRefresh.
export async function startPopupSimulationRefreshInBackground({ invalidateOldState = true, ...services }: PopupSimulationRefresh): Promise<void> {
	const request = await preparePopupVisualisationRefresh(services, invalidateOldState, true).catch((error: unknown) => {
		if (isRpcConfigurationUnavailableError(error)) return undefined
		throw error
	})
	if (request === undefined) return
	const queued = refreshQueue.toQueued(services, request)
	backgroundTaskSupervisor.start({ source: 'popup_simulation_refresh' }, async () => await refreshQueue.refresh(queued, invalidateOldState))
}
