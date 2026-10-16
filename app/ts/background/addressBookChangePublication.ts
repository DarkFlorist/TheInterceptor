import type { SimulationServices } from '../simulation/serviceLifecycle.js'
import { isExpectedInfrastructureError, reportUnexpectedError } from '../utils/errors.js'
import { sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { relabelDisplayedConfirmationSimulation } from './confirmationRelabel.js'
import { relabelPopupVisualisation } from './popupVisualisationUpdater.js'

// Counts the address-book changes published in this background session. It lives in memory only and is not a version of the stored address book: it restarts at zero with the background, and re-labels never bump it.
let publishedAddressBookRevision = 0

// Read by simulateAndStoreConfirmationRun before a confirmation run's lookups and again after its store, to tell whether a change was published in between.
export const getPublishedAddressBookRevision = () => publishedAddressBookRevision

// A re-label only replaces names on a result that is already stored, so its failure is reported without failing the address-book change or the confirmation run that requested it.
export async function relabelReportingUnexpectedErrors(relabel: Promise<void>) {
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
	// Bumped before anything is awaited, so a confirmation run that started its lookups earlier sees the change once it has stored its run.
	publishedAddressBookRevision += 1
	const addressBookChangeBroadcast = sendPopupMessageToOpenWindows({ method: 'popup_addressBookEntriesChanged' })
	void relabelStoredSimulationsAndNotify(services)
	await addressBookChangeBroadcast
}
