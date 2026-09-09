// Coalesce interactive requests only; popupVisualisationUpdater owns execution, cancellation and stored state. See docs/popup-simulation-refresh.md.
import { Future } from '../utils/future.js'
import type { SimulationServices } from '../simulation/serviceLifecycle.js'
import { getAddressesbeingMadeRich, getCurrentSimulationInput } from './simulationUpdating.js'
import { getPopupVisualisationFingerprint } from './popupSimulationFingerprint.js'
import { getSettings } from './settings.js'
import { getActiveStackContext } from '../utils/activeStackContext.js'
import { stringifyJSONWithBigInts } from '../utils/bigint.js'
import { type PopupSimulationSnapshot, updatePopupVisualisationIfNeeded } from './popupVisualisationUpdater.js'

export type PopupSimulationRefresh = SimulationServices & { readonly invalidateOldState?: boolean }
export type RevisionedPopupSimulationRefresh = PopupSimulationRefresh & { readonly revision: string | symbol }

export type PopupSimulationRefreshOutcome = { readonly status: 'superseded' } | { readonly status: 'observed', readonly available: boolean }

// An observed result describes stored availability after an attempt, not which request published it.
export function createPopupSimulationRefresher<T extends RevisionedPopupSimulationRefresh>(refresh: (services: T) => Promise<boolean>) {
	type Entry = { services: T, readonly result: Future<PopupSimulationRefreshOutcome> }
	let pending: Entry | undefined
	let active: Entry | undefined
	let draining = false
	const sameRevision = (left: T, right: T) => left.revision === right.revision
		&& left.ethereum === right.ethereum && left.tokenPriceService === right.tokenPriceService

	const drain = async () => {
		while (pending !== undefined) {
			const entry = pending
			pending = undefined
			active = entry
			// Settle only this entry, including thrown failures, then continue with independently queued work.
			await Promise.resolve().then(() => refresh(entry.services)).then(
				value => { active = undefined; entry.result.resolve({ status: 'observed', available: value }) },
				error => { active = undefined; entry.result.reject(error) },
			)
		}
		draining = false
	}

	return (services: T): Promise<PopupSimulationRefreshOutcome> => {
		if (pending !== undefined && sameRevision(pending.services, services)) {
			pending.services = { ...services, invalidateOldState: services.invalidateOldState || pending.services.invalidateOldState }
			return pending.result.asPromise
		}
		// In A → B → A, the last A must replace pending B rather than join the active A.
		if (pending === undefined && active !== undefined && sameRevision(active.services, services)
			&& (!services.invalidateOldState || active.services.invalidateOldState)) return active.result.asPromise
		const entry: Entry = {
			services: { ...services, invalidateOldState: services.invalidateOldState || pending?.services.invalidateOldState },
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

const refreshRevision = createPopupSimulationRefresher<RevisionedPopupSimulationRefresh & { readonly snapshot: PopupSimulationSnapshot }>(async ({ ethereum, tokenPriceService, invalidateOldState = false, snapshot }) => {
	const result = await updatePopupVisualisationIfNeeded(ethereum, tokenPriceService, invalidateOldState, false, !invalidateOldState, snapshot)
	return result.simulationUpdatingState !== 'failed' && result.simulationResultState !== 'invalid'
})

export async function queuePopupSimulationRefresh(services: PopupSimulationRefresh) {
	const richAddresses = await getAddressesbeingMadeRich()
	const [input, settings] = await Promise.all([getCurrentSimulationInput(richAddresses), getSettings()])
	// Keep the revision and the input consumed after asynchronous consumer/storage checks together.
	const snapshot = { simulationStateInput: input, numberOfAddressesMadeRich: richAddresses.length }
	const block = services.ethereum.getCachedBlock()
	// Without a cached head we cannot prove that two requests cover the same block; keep the follow-up refresh.
	const revision = block === undefined ? Symbol('uncached block') : stringifyJSONWithBigInts([
		getPopupVisualisationFingerprint(input, services.ethereum.getRpcEntry(), block.number),
		block.hash,
		snapshot.numberOfAddressesMadeRich,
		getActiveStackContext(settings),
	])
	return await refreshRevision({ ...services, revision, snapshot })
}
