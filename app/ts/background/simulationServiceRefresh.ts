import type { SimulationServicesUpdateObserver } from '../simulation/serviceLifecycle.js'
import { selectionShowsStack } from '../utils/simulationSelection.js'
import { getSettings } from './settings.js'
import { publishFailedPopupVisualisation } from './popupVisualisationUpdater.js'
import { startPopupSimulationRefreshInBackground } from './popupSimulationRefreshQueue.js'

// One policy for every owner replacement and selection refresh, after the complete update has settled.
export const refreshAfterSimulationServicesUpdate: SimulationServicesUpdateObserver = async (services, outcome) => {
	if (!services.ethereum.isCurrent()) return
	// Only a failed replacement prevents preparing the committed selection. Later notification or storage errors do not turn an installed provider into a failed one.
	if (outcome.replacement === 'failed') {
		await publishFailedPopupVisualisation({ isCurrent: services.ethereum.isCurrent })
		return
	}
	// Settings transitions do not wait for RPC work; the background refresh publishes its updating state before this returns, and its preparation steps aside if the services were replaced meanwhile.
	if (selectionShowsStack(await getSettings())) await startPopupSimulationRefreshInBackground(services)
}
