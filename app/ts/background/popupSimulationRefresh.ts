import type { SimulationServices } from '../simulation/serviceLifecycle.js'
import { updatePopupVisualisationIfNeeded } from './popupVisualisationUpdater.js'

export type PopupSimulationRefresh = SimulationServices & { readonly invalidateOldState?: boolean }

// All callers await the same drain; updates arriving during a refresh trigger one follow-up with the latest services.
export function createPopupSimulationRefresher(refresh: (services: PopupSimulationRefresh) => Promise<boolean>) {
	let pendingServices: PopupSimulationRefresh | undefined
	let running: Promise<boolean> | undefined
	return (services: PopupSimulationRefresh): Promise<boolean> => {
		pendingServices = { ...services, invalidateOldState: services.invalidateOldState || pendingServices?.invalidateOldState }
		if (running !== undefined) return running
		running = Promise.resolve().then(async () => {
			try {
				let refreshed = true
				while (pendingServices !== undefined) {
					const currentServices = pendingServices
					pendingServices = undefined
					refreshed = await refresh(currentServices)
				}
				return refreshed
			} finally {
				pendingServices = undefined
				running = undefined
			}
		})
		return running
	}
}

export const refreshPopupSimulation = createPopupSimulationRefresher(async ({ ethereum, tokenPriceService, invalidateOldState = false }) => {
	const result = await updatePopupVisualisationIfNeeded(ethereum, tokenPriceService, invalidateOldState, false, !invalidateOldState)
	return result.simulationUpdatingState !== 'failed' && result.simulationResultState !== 'invalid'
})
