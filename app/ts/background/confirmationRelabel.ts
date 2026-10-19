// Coordinates the address-book re-labels of the displayed confirmation: the re-label each published address-book change requests, and the catch-up re-label of a confirmation run whose lookups overlapped a change. It owns both the count of published changes and the writer that stores confirmation runs, so the catch-up follows from what the write did; see "Address-book re-labels" in docs/popup-simulation-refresh.md.
import type { PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import type { RpcNetwork } from '../types/rpc.js'
import type { UniqueRequestIdentifier } from '../utils/requests.js'
import { Semaphore } from '../utils/semaphore.js'
import { modifyObject } from '../utils/typescript.js'
import { relabelReportingUnexpectedErrors, relabelStoredSimulation, type SimulationRunToRelabel } from './simulationRelabel.js'
import { getPendingTransactionsAndMessages, updatePendingTransactionOrMessage } from './storageVariables.js'

// Only a successful simulation of a pending transaction on the services' chain can be re-labelled: failed or still pending simulations show no names to re-label, and a run stored without a simulationId by an older version cannot be told apart from a newer run.
function getConfirmationRunToRelabel(pending: PendingTransactionOrSignableMessage, chainId: bigint): SimulationRunToRelabel<PendingTransactionOrSignableMessage> | undefined {
	if (pending.type !== 'Transaction' || pending.transactionOrMessageCreationStatus !== 'Simulated' || pending.popupVisualisation.statusCode !== 'success') return undefined
	const visualisation = pending.popupVisualisation.data
	if (visualisation.simulationId === undefined || visualisation.simulationState.rpcNetwork.chainId !== chainId) return undefined
	return {
		simulationId: visualisation.simulationId,
		simulationState: visualisation.simulationState,
		storedMetadata: visualisation,
		withMetadata: (metadata) => modifyObject(pending, { popupVisualisation: { statusCode: 'success', data: modifyObject(visualisation, metadata) } }),
	}
}

// One re-label at a time, so the last one requested reads the latest address book.
const confirmationRelabelSemaphore = new Semaphore(1)

// Re-labels the stored run of the confirmation the dialog displays without simulating. A newer simulation run of the request does not cancel it: the write guard in relabelStoredSimulation keeps it from replacing a run stored meanwhile, and a newer run that stores nothing, because it was aborted or its RPC request failed, leaves the re-labelled run in place.
async function relabelDisplayedConfirmationSimulation(rpcNetwork: RpcNetwork) {
	await confirmationRelabelSemaphore.execute(async () => {
		const [displayed] = await getPendingTransactionsAndMessages()
		if (displayed === undefined) return
		await relabelStoredSimulation(rpcNetwork, {
			stored: displayed,
			getRunToRelabel: (pending) => getConfirmationRunToRelabel(pending, rpcNetwork.chainId),
			updateStored: async (relabel) => await updatePendingTransactionOrMessage(displayed.uniqueRequestIdentifier, async (current) => relabel(current)),
			abortController: undefined,
		})
	})
}

// Counts the address-book changes published in this background session, as relabelDisplayedConfirmationAfterAddressBookChange is told of each. It lives in memory only and is not a version of the stored address book: it restarts at zero with the background, and re-labels never bump it.
let publishedAddressBookChanges = 0

// The address-book publication's one notification of a published change. The change is counted before this returns, so a confirmation run whose lookups are still running catches it up once stored; the returned promise re-labels the displayed confirmation's stored run.
export function relabelDisplayedConfirmationAfterAddressBookChange(rpcNetwork: RpcNetwork) {
	publishedAddressBookChanges += 1
	return relabelDisplayedConfirmationSimulation(rpcNetwork)
}

// The id of the confirmation run a pending confirmation stores; every new run gets a new id.
const getStoredConfirmationRunId = (pending: PendingTransactionOrSignableMessage) => pending.type === 'Transaction' && (pending.transactionOrMessageCreationStatus === 'Simulated' || pending.transactionOrMessageCreationStatus === 'FailedToSimulate')
	? pending.popupVisualisation.data.simulationId
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

// Every confirmation workflow that simulates and stores a confirmation run does so through this, writing the run with the storeRun it is handed, which is exported nowhere else. The re-label a published change requests reaches only stored runs, so a run whose lookups overlapped the change would otherwise keep the old names once stored, as would a request's first run, which no re-label can reach before it is stored. When storeRun stored a new run during which a change was published, this re-labels the displayed confirmation once, however many changes were published.
export async function simulateAndStoreConfirmationWithAddressBookCatchUp<Result>(rpcNetwork: RpcNetwork, simulateAndStore: (storeRun: StoreConfirmationRun) => Promise<Result>) {
	// Read before the run's first lookup, so a change published at any point until the run is stored is caught up.
	const publishedAddressBookChangesBeforeRun = publishedAddressBookChanges
	let storedNewRun = false
	const result = await simulateAndStore(async (uniqueRequestIdentifier, update) => {
		const outcome = await storeConfirmationRun(uniqueRequestIdentifier, update)
		if (outcome.storedNewRun) storedNewRun = true
		return outcome
	})
	if (storedNewRun && publishedAddressBookChanges !== publishedAddressBookChangesBeforeRun) {
		await relabelReportingUnexpectedErrors(relabelDisplayedConfirmationSimulation(rpcNetwork))
	}
	return result
}
