import type { SimulationServicesOwner } from '../simulation/serviceLifecycle.js'
import type { AddressBookEntries } from '../types/addressBookTypes.js'
import { startPopupSimulationRefreshInBackground } from './popupSimulationRefreshQueue.js'
import { updateUserAddressBookEntries } from './addressBookStorage.js'

// Writes a user-facing address-book edit (every address-book write reconciles rich-mode funding) and starts a background popup refresh when that funding changed, so address edits do not wait for RPC work. Shared by the address-book editor and watch-asset approvals so both keep the simulation current.
export async function updateAddressBookAndRefreshChangedFunding(simulationServicesOwner: SimulationServicesOwner, update: (entries: AddressBookEntries) => AddressBookEntries) {
	const result = await updateUserAddressBookEntries(update)
	if (result.ok && result.fundingChanged) await startPopupSimulationRefreshInBackground({ ...simulationServicesOwner.getCurrent(), invalidateOldState: true })
	return result
}
