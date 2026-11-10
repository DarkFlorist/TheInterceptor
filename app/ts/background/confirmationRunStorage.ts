// Writes confirmation simulation runs into their pending confirmations. It only stores: it returns the run it stored, and the workflow that started the run decides what follows, such as the address-book catch-up re-label (relabelStoredRunIfAddressBookChangedDuringIt in confirmationRelabel.ts). See "Address-book re-labels" in docs/popup-simulation-refresh.md.
import type { PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import type { UniqueRequestIdentifier } from '../utils/requests.js'
import { updatePendingTransactionOrMessage } from './storageVariables.js'

// A confirmation run as it was stored: the request it belongs to and its run id, which together identify it in storage, and the address-book revision it read when it started.
export type StoredConfirmationRun = {
	readonly uniqueRequestIdentifier: UniqueRequestIdentifier
	readonly confirmationRunId: number
	// Undefined only for a run stored without the revision, which a catch-up therefore treats as changed.
	readonly addressBookRevisionBeforeLookups: number | undefined
}

function getStoredConfirmationRunData(pending: PendingTransactionOrSignableMessage) {
	if (pending.type !== 'Transaction' || (pending.transactionOrMessageCreationStatus !== 'Simulated' && pending.transactionOrMessageCreationStatus !== 'FailedToSimulate')) return undefined
	return pending.popupVisualisation.data
}

// The id of the confirmation run a pending confirmation stores; every new run gets a new id, so the writer tells a new run from the stored one by it and a re-label writes only onto the run it read.
export const getStoredConfirmationRunId = (pending: PendingTransactionOrSignableMessage) => getStoredConfirmationRunData(pending)?.confirmationRunId

function getStoredConfirmationRun(pending: PendingTransactionOrSignableMessage): StoredConfirmationRun | undefined {
	const data = getStoredConfirmationRunData(pending)
	if (data?.confirmationRunId === undefined) return undefined
	return { uniqueRequestIdentifier: pending.uniqueRequestIdentifier, confirmationRunId: data.confirmationRunId, addressBookRevisionBeforeLookups: data.addressBookRevisionBeforeLookups }
}

// Updates a pending confirmation as updatePendingTransactionOrMessage does, and returns the confirmation run the write stored, one whose run id differs from that of the run stored before. An update that keeps the stored run, such as one that only records an approval error or loses to a newer stored run, stored none and returns undefined.
export async function storeConfirmationRun(uniqueRequestIdentifier: UniqueRequestIdentifier, update: (current: PendingTransactionOrSignableMessage) => Promise<PendingTransactionOrSignableMessage | undefined>) {
	let storedRun: StoredConfirmationRun | undefined
	await updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (current) => {
		const updated = await update(current)
		const updatedRun = updated === undefined ? undefined : getStoredConfirmationRun(updated)
		storedRun = updatedRun !== undefined && updatedRun.confirmationRunId !== getStoredConfirmationRunId(current) ? updatedRun : undefined
		return updated
	})
	return storedRun
}
