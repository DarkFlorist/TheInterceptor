// Stores confirmation simulation runs, and re-labels a stored run whose lookups an address-book change published during the run may have missed. The confirmation window and Safe signer selection store runs only through simulateAndStoreConfirmationRun. See "Address-book re-labels" in docs/popup-simulation-refresh.md.
import type { PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import type { RpcNetwork } from '../types/rpc.js'
import type { UniqueRequestIdentifier } from '../utils/requests.js'
import { getPublishedAddressBookChangeCount } from './addressBookChangePublication.js'
import { getStoredConfirmationRunId, relabelDisplayedConfirmationSimulation } from './confirmationRelabel.js'
import { relabelReportingUnexpectedErrors } from './simulationRelabel.js'
import { updatePendingTransactionOrMessage } from './storageVariables.js'

// Updates a pending confirmation as updatePendingTransactionOrMessage does, and reports whether the write stored a new confirmation run, one whose run id differs from that of the run stored before. An update that keeps the stored run, such as one that only records an approval error or loses to a newer stored run, stores none.
export type StoreConfirmationRun = (uniqueRequestIdentifier: UniqueRequestIdentifier, update: (current: PendingTransactionOrSignableMessage) => Promise<PendingTransactionOrSignableMessage | undefined>) => Promise<{ readonly storedNewRun: boolean }>

const storeConfirmationRun: StoreConfirmationRun = async (uniqueRequestIdentifier, update) => {
	let storedNewRun = false
	await updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (current) => {
		const updated = await update(current)
		const updatedRunId = updated === undefined ? undefined : getStoredConfirmationRunId(updated)
		storedNewRun = updatedRunId !== undefined && updatedRunId !== getStoredConfirmationRunId(current)
		return updated
	})
	return { storedNewRun }
}

// The only writer of confirmation runs: simulateAndStore gets storeRun nowhere else, so every stored run read the published address-book change count before its first lookup. Workflows store runs through it rather than with updatePendingTransactionOrMessage because only the run knows when its lookups began. The re-label that follows an address-book change reaches only runs already stored, so a run during which a change was published, whose lookups may have read the address book from before it, re-labels the displayed confirmation once it has stored a new run, awaited so the caller's following dialog update shows the new names. A run that stored no new run, because it was aborted or a newer run was kept, has nothing to re-label.
export async function simulateAndStoreConfirmationRun<Result>(rpcNetwork: RpcNetwork, simulateAndStore: (storeRun: StoreConfirmationRun) => Promise<Result>) {
	const addressBookChangesBeforeLookups = getPublishedAddressBookChangeCount()
	let storedNewRun = false
	const result = await simulateAndStore(async (uniqueRequestIdentifier, update) => {
		const outcome = await storeConfirmationRun(uniqueRequestIdentifier, update)
		if (outcome.storedNewRun) storedNewRun = true
		return outcome
	})
	// Compared once the run is stored: a change counted later starts its own re-label after this run is stored, which reaches it. However many changes were published meanwhile, one re-label reads them all.
	if (storedNewRun && getPublishedAddressBookChangeCount() !== addressBookChangesBeforeLookups) await relabelReportingUnexpectedErrors(relabelDisplayedConfirmationSimulation(rpcNetwork))
	return result
}
