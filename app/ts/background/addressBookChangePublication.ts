import type { SimulationServices } from '../simulation/serviceLifecycle.js'
import { sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { relabelDisplayedConfirmationSimulation } from './confirmationRelabel.js'
import { markConfirmationRunsInFlightStale } from './confirmationRunStorage.js'
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
	const rpcNetwork = services.ethereum.getRpcEntry()
	// The re-label below reaches only stored runs, so a confirmation run in flight, whose lookups may have read the address book from before this change, re-labels the displayed confirmation once it has stored its run. Marked before anything is awaited, so no run that started before the change is missed.
	markConfirmationRunsInFlightStale(async () => await relabelReportingUnexpectedErrors(relabelDisplayedConfirmationSimulation(rpcNetwork)))
	const displayedConfirmationRelabel = relabelDisplayedConfirmationSimulation(rpcNetwork)
	const addressBookChangeBroadcast = sendPopupMessageToOpenWindows({ method: 'popup_addressBookEntriesChanged' })
	void relabelStoredSimulationsAndNotify(services, displayedConfirmationRelabel)
	await addressBookChangeBroadcast
}
