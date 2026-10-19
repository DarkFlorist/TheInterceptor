// Coordinates the address-book re-labels of the displayed confirmation: the re-label each published address-book change requests, and the catch-up re-label of a confirmation run whose lookups overlapped a change; see "Address-book re-labels" in docs/popup-simulation-refresh.md.
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
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
async function relabelDisplayedConfirmationSimulation(ethereum: EthereumClientService) {
	await confirmationRelabelSemaphore.execute(async () => {
		const [displayed] = await getPendingTransactionsAndMessages()
		if (displayed === undefined) return
		const chainId = ethereum.getChainId()
		await relabelStoredSimulation(ethereum, {
			stored: displayed,
			getRunToRelabel: (pending) => getConfirmationRunToRelabel(pending, chainId),
			updateStored: async (relabel) => await updatePendingTransactionOrMessage(displayed.uniqueRequestIdentifier, async (current) => relabel(current)),
			abortController: undefined,
		})
	})
}

// Counts the address-book changes published in this background session, as relabelDisplayedConfirmationAfterAddressBookChange is told of each. It lives in memory only and is not a version of the stored address book: it restarts at zero with the background, and re-labels never bump it.
let publishedAddressBookChanges = 0

// The address-book publication's one notification of a published change. The change is counted before this returns, so a confirmation run whose lookups are still running catches it up once stored; the returned promise re-labels the displayed confirmation's stored run.
export function relabelDisplayedConfirmationAfterAddressBookChange(ethereum: EthereumClientService) {
	publishedAddressBookChanges += 1
	return relabelDisplayedConfirmationSimulation(ethereum)
}

type ConfirmationRunStoreOutcome<Result> = {
	// Whether this call stored a new confirmation run. An aborted run returns no run to store, and a run superseded by a newer stored run or by the request's resolution is not stored.
	readonly storedNewRun: boolean
	readonly result: Result
}

// Every confirmation workflow that stores a confirmation simulation run simulates and stores it through this. The re-label a published change requests reaches only stored runs, so a run whose lookups overlapped the change would otherwise keep the old names once stored, as would a request's first run, which no re-label can reach before it is stored. After storing such a run, this re-labels the displayed confirmation once, however many changes were published during the run.
export async function simulateAndStoreConfirmationWithAddressBookCatchUp<Result>(ethereum: EthereumClientService, simulateAndStore: () => Promise<ConfirmationRunStoreOutcome<Result>>) {
	// Read before the run's first lookup, so a change published at any point until the run is stored is caught up.
	const publishedAddressBookChangesBeforeRun = publishedAddressBookChanges
	const { storedNewRun, result } = await simulateAndStore()
	if (storedNewRun && publishedAddressBookChanges !== publishedAddressBookChangesBeforeRun) {
		await relabelReportingUnexpectedErrors(relabelDisplayedConfirmationSimulation(ethereum))
	}
	return result
}
