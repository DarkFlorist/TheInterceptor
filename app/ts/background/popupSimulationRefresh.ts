import type { SimulationServices } from '../simulation/serviceLifecycle.js'
import { getAddressesbeingMadeRich, getCurrentSimulationInput } from './simulationUpdating.js'
import { getPopupVisualisationFingerprint } from './popupSimulationFingerprint.js'
import { getSettings } from './settings.js'
import { getActiveStackContext } from '../utils/activeStackContext.js'
import { stringifyJSONWithBigInts } from '../utils/bigint.js'
import { type PopupSimulationSnapshot, updatePopupVisualisationIfNeeded } from './popupVisualisationUpdater.js'

export type PopupSimulationRefresh = SimulationServices & { readonly invalidateOldState?: boolean }
export type RevisionedPopupSimulationRefresh = PopupSimulationRefresh & { readonly revision: string | symbol }

// Identical revisions join active work unless a newer request is queued: in A → B → A, the last A must replace pending B.
export function createPopupSimulationRefresher<T extends RevisionedPopupSimulationRefresh>(refresh: (services: T) => Promise<boolean>) {
	let pendingServices: T | undefined
	let activeServices: T | undefined
	let running: Promise<boolean> | undefined
	return (services: T): Promise<boolean> => {
		if (pendingServices === undefined && running !== undefined && activeServices !== undefined
			&& activeServices.revision === services.revision
			&& activeServices.ethereum === services.ethereum
			&& activeServices.tokenPriceService === services.tokenPriceService
			&& (!services.invalidateOldState || activeServices.invalidateOldState)) return running
		pendingServices = { ...services, invalidateOldState: services.invalidateOldState || pendingServices?.invalidateOldState }
		if (running !== undefined) return running
		running = Promise.resolve().then(async () => {
			try {
				let refreshed = true
				while (pendingServices !== undefined) {
					const currentServices = pendingServices
					pendingServices = undefined
					activeServices = currentServices
					refreshed = await refresh(currentServices)
				}
				return refreshed
			} finally {
				pendingServices = undefined
				activeServices = undefined
				running = undefined
			}
		})
		return running
	}
}

const refreshRevision = createPopupSimulationRefresher<RevisionedPopupSimulationRefresh & { readonly snapshot: PopupSimulationSnapshot }>(async ({ ethereum, tokenPriceService, invalidateOldState = false, snapshot }) => {
	const result = await updatePopupVisualisationIfNeeded(ethereum, tokenPriceService, invalidateOldState, false, !invalidateOldState, snapshot)
	return result.simulationUpdatingState !== 'failed' && result.simulationResultState !== 'invalid'
})

export async function refreshPopupSimulation(services: PopupSimulationRefresh) {
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
