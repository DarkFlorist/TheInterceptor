// Stores confirmation simulation runs. The confirmation window and Safe signer selection store runs only through simulateAndStoreConfirmationRun; the address-book re-label depends on this module, never the other way round. See "Address-book re-labels" in docs/popup-simulation-refresh.md.
import type { PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import type { UniqueRequestIdentifier } from '../utils/requests.js'
import { updatePendingTransactionOrMessage } from './storageVariables.js'

// The id of the confirmation run a pending confirmation stores; every new run gets a new id, so the writer tells a new run from the stored one by it and a re-label writes only onto the run it read.
export const getStoredConfirmationRunId = (pending: PendingTransactionOrSignableMessage) => pending.type === 'Transaction' && (pending.transactionOrMessageCreationStatus === 'Simulated' || pending.transactionOrMessageCreationStatus === 'FailedToSimulate')
	? pending.popupVisualisation.data.confirmationRunId
	: undefined

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

// A confirmation run from before its first lookup until it has stored its run or given up; refreshOnceStored is set once what the run reads may have changed while it runs.
type ConfirmationRunInFlight = { refreshOnceStored: (() => Promise<void>) | undefined }

const confirmationRunsInFlight = new Set<ConfirmationRunInFlight>()

// Marks every confirmation run now in flight stale: what its lookups read may have changed while it runs, so once it has stored a new run, refresh brings the stored run up to date. A run marked again keeps its first refresh, which runs after the run is stored and so also reads what every later mark changed.
export function markConfirmationRunsInFlightStale(refresh: () => Promise<void>) {
	for (const run of confirmationRunsInFlight) run.refreshOnceStored ??= refresh
}

// The only writer of confirmation runs: simulateAndStore gets storeRun nowhere else, so every stored run was in flight from before its first lookup and cannot skip the refresh of a stale run. Whoever changes what runs read, such as an address-book change, marks the runs in flight stale through markConfirmationRunsInFlightStale, so this module needs no knowledge of it. A run that stored no new run, because it was aborted or a newer run was kept, has nothing to refresh.
export async function simulateAndStoreConfirmationRun<Result>(simulateAndStore: (storeRun: StoreConfirmationRun) => Promise<Result>) {
	const run: ConfirmationRunInFlight = { refreshOnceStored: undefined }
	confirmationRunsInFlight.add(run)
	let storedNewRun = false
	let result: Result
	try {
		result = await simulateAndStore(async (uniqueRequestIdentifier, update) => {
			const outcome = await storeConfirmationRun(uniqueRequestIdentifier, update)
			if (outcome.storedNewRun) storedNewRun = true
			return outcome
		})
	} finally {
		// Also when simulateAndStore throws before returning its promise, so no run stays in flight to be marked stale later.
		confirmationRunsInFlight.delete(run)
	}
	if (storedNewRun && run.refreshOnceStored !== undefined) await run.refreshOnceStored()
	return result
}
