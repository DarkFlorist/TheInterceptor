import type { SimulationServicesOwner } from '../simulation/serviceLifecycle.js'
import type { AddressBookEntries } from '../types/addressBookTypes.js'
import { queuePopupSimulationRefresh } from './popupSimulationRefreshQueue.js'
import { updateAddressBookAndReconcileRichMode } from './richModeSettings.js'

// Writes an address-book edit that can remove or change a funded token, reconciles rich-mode funding with it, and refreshes the popup simulation when the funding changed. Shared by the address-book editor and watch-asset approvals so both keep the simulation current.
export async function updateAddressBookAndRefreshChangedFunding(simulationServicesOwner: SimulationServicesOwner, update: (entries: AddressBookEntries) => AddressBookEntries) {
	const result = await updateAddressBookAndReconcileRichMode(update)
	if (result.ok && result.fundingChanged) await queuePopupSimulationRefresh({ ...simulationServicesOwner.getCurrent(), invalidateOldState: true })
	return result
}
