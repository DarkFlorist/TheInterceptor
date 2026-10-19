import type { SimulationServices } from '../simulation/serviceLifecycle.js'
import { sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { relabelDisplayedConfirmationAfterAddressBookChange } from './confirmationRelabel.js'
import { relabelPopupVisualisation } from './popupVisualisationUpdater.js'
import { relabelReportingUnexpectedErrors } from './simulationRelabel.js'

// Notifies even when there was nothing to re-label, so the notification always marks the end of the re-label.
async function relabelStoredSimulationsAndNotify({ ethereum }: SimulationServices, displayedConfirmationRelabel: Promise<void>) {
	await Promise.all([
		relabelReportingUnexpectedErrors(relabelPopupVisualisation(ethereum)),
		relabelReportingUnexpectedErrors(displayedConfirmationRelabel),
	])
	await sendPopupMessageToOpenWindows({ method: 'popup_simulationsRelabelled' })
}

// Callers wait only for the address-book change broadcast, never for the background re-label; see "Address-book re-labels" in docs/popup-simulation-refresh.md.
export async function publishAddressBookChangeAndRelabelSimulations(services: SimulationServices) {
	// The confirmation coordinator is told of the change before anything is awaited, so a confirmation run that started its lookups earlier catches the change up once it has stored its run.
	const displayedConfirmationRelabel = relabelDisplayedConfirmationAfterAddressBookChange(services.ethereum)
	const addressBookChangeBroadcast = sendPopupMessageToOpenWindows({ method: 'popup_addressBookEntriesChanged' })
	void relabelStoredSimulationsAndNotify(services, displayedConfirmationRelabel)
	await addressBookChangeBroadcast
}
