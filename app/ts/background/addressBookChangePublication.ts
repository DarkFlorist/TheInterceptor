import type { SimulationServices } from '../simulation/serviceLifecycle.js'
import { countPublishedAddressBookChange } from './addressBookChangeCount.js'
import { sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { relabelDisplayedConfirmationSimulation } from './confirmationRelabel.js'
import { relabelPopupVisualisation } from './popupVisualisationUpdater.js'
import { relabelReportingUnexpectedErrors } from './simulationRelabel.js'

// Notifies even when there was nothing to re-label, so the notification always marks the end of the re-label.
async function relabelStoredSimulationsAndNotify({ ethereum }: SimulationServices, displayedConfirmationRelabel: Promise<void>) {
	await Promise.all([
		relabelReportingUnexpectedErrors(relabelPopupVisualisation(ethereum.getRpcEntry())),
		relabelReportingUnexpectedErrors(displayedConfirmationRelabel),
	])
	await sendPopupMessageToOpenWindows({ method: 'popup_simulationsRelabelled' })
}

// Publishes an address-book change that is already stored. Callers wait only for the address-book change broadcast, never for the background re-label; see "Address-book re-labels" in docs/popup-simulation-refresh.md.
export async function publishAddressBookChangeAndRelabelSimulations(services: SimulationServices) {
	// Counted before the re-label below reads the stored runs, so a confirmation run that is stored after that read sees the change and re-labels itself.
	countPublishedAddressBookChange()
	const displayedConfirmationRelabel = relabelDisplayedConfirmationSimulation(services.ethereum.getRpcEntry())
	const addressBookChangeBroadcast = sendPopupMessageToOpenWindows({ method: 'popup_addressBookEntriesChanged' })
	void relabelStoredSimulationsAndNotify(services, displayedConfirmationRelabel)
	await addressBookChangeBroadcast
}
