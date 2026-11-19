import type { SimulationServicesUpdateObserver } from '../simulation/serviceLifecycle.js'
import { selectionShowsStack } from '../utils/simulationSelection.js'
import { getSettings } from './settings.js'
import { publishFailedPopupVisualisation } from './popupVisualisationUpdater.js'
import { queuePopupSimulationRefresh } from './popupSimulationRefreshQueue.js'

// One policy for every owner replacement and selection refresh, after the complete update has settled.
export const refreshAfterSimulationServicesUpdate: SimulationServicesUpdateObserver = async (services, outcome) => {
	if (!services.ethereum.isCurrent()) return
	// A replacement/preparation failure retires the old view. A notification failure after a refresh-only request still owes the committed selection its normal refresh.
	if (outcome.status === 'failed' && outcome.invalidateOldState) {
		await publishFailedPopupVisualisation({ isCurrent: services.ethereum.isCurrent })
		return
	}
	if (selectionShowsStack(await getSettings())) await queuePopupSimulationRefresh({ ...services, invalidateOldState: outcome.invalidateOldState })
}
