import type { SimulationServices } from '../simulation/serviceLifecycle.js'
import { isExpectedInfrastructureError, reportUnexpectedError } from '../utils/errors.js'
import { sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { recordPublishedAddressBookChange, relabelDisplayedConfirmationSimulation } from './confirmationRelabel.js'
import { relabelPopupVisualisation } from './popupVisualisationUpdater.js'

// The address book is already saved when a re-label fails, so the other re-label and the notification still follow.
async function relabelReportingUnexpectedErrors(relabel: Promise<void>) {
	try {
		await relabel
	} catch (error: unknown) {
		if (!isExpectedInfrastructureError(error)) await reportUnexpectedError(error)
	}
}

// Notifies even when there was nothing to re-label, so the notification always marks the end of the re-label.
async function relabelStoredSimulationsAndNotify({ ethereum, tokenPriceService }: SimulationServices) {
	await Promise.all([
		relabelReportingUnexpectedErrors(relabelPopupVisualisation(ethereum, tokenPriceService)),
		relabelReportingUnexpectedErrors(relabelDisplayedConfirmationSimulation(ethereum, tokenPriceService)),
	])
	await sendPopupMessageToOpenWindows({ method: 'popup_simulationsRelabelled' })
}

// Callers wait only for the address-book change broadcast, never for the background re-label; see "Address-book re-labels" in docs/popup-simulation-refresh.md.
export async function publishAddressBookChangeAndRelabelSimulations(services: SimulationServices) {
	// Recorded before anything is awaited, so a confirmation run still looking up names redoes its lookups (see visualizeConfirmationWithLatestAddressBook).
	recordPublishedAddressBookChange()
	const addressBookChangeBroadcast = sendPopupMessageToOpenWindows({ method: 'popup_addressBookEntriesChanged' })
	void relabelStoredSimulationsAndNotify(services)
	await addressBookChangeBroadcast
}
