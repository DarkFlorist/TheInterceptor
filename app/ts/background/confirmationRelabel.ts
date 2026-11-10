// Re-labels stored confirmation runs when the address book changes: addressBookChangePublication.ts requests a re-label of the displayed confirmation for each published change, and each confirmation workflow requests a re-label of the run it just stored when the address book changed during that run. See "Address-book re-labels" in docs/popup-simulation-refresh.md.
import type { PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import type { RpcNetwork } from '../types/rpc.js'
import { doesUniqueRequestIdentifiersMatch } from '../utils/requests.js'
import { Semaphore } from '../utils/semaphore.js'
import { modifyObject } from '../utils/typescript.js'
import { getStoredConfirmationRunId, type StoredConfirmationRun } from './confirmationRunStorage.js'
import { relabelReportingUnexpectedErrors, relabelStoredSimulation, type SimulationRunToRelabel } from './simulationRelabel.js'
import { getPendingTransactionsAndMessages, getSettledAddressBookRevision, updatePendingTransactionOrMessage } from './storageVariables.js'

// Only a successful simulation of a pending transaction on the services' chain can be re-labelled: failed or still pending simulations show no names to re-label, and a run stored without a confirmationRunId by an older version cannot be told apart from a newer run.
function getConfirmationRunToRelabel(pending: PendingTransactionOrSignableMessage, chainId: bigint): SimulationRunToRelabel<PendingTransactionOrSignableMessage> | undefined {
	if (pending.type !== 'Transaction' || pending.transactionOrMessageCreationStatus !== 'Simulated' || pending.popupVisualisation.statusCode !== 'success') return undefined
	const visualisation = pending.popupVisualisation.data
	const confirmationRunId = getStoredConfirmationRunId(pending)
	if (confirmationRunId === undefined || visualisation.simulationState.rpcNetwork.chainId !== chainId) return undefined
	return {
		runId: confirmationRunId,
		simulationState: visualisation.simulationState,
		storedMetadata: visualisation,
		withMetadata: (metadata) => modifyObject(pending, { popupVisualisation: { statusCode: 'success', data: modifyObject(visualisation, metadata) } }),
	}
}

// One re-label at a time, so the last one requested reads the latest address book.
const confirmationRelabelSemaphore = new Semaphore(1)

// Re-labels the stored run of one pending confirmation without simulating; isRunToRelabel limits it to a particular run. Nothing cancels it, not even a newer simulation run of the request: the write guard in relabelStoredSimulation keeps it from replacing a run stored meanwhile, and a newer run that stores nothing, because it was aborted or its RPC request failed, leaves the re-labelled run in place.
async function relabelStoredConfirmation(rpcNetwork: RpcNetwork, stored: PendingTransactionOrSignableMessage, isRunToRelabel: (pending: PendingTransactionOrSignableMessage) => boolean) {
	await relabelStoredSimulation(rpcNetwork, {
		stored,
		getRunToRelabel: (pending) => isRunToRelabel(pending) ? getConfirmationRunToRelabel(pending, rpcNetwork.chainId) : undefined,
		updateStored: async (relabel) => await updatePendingTransactionOrMessage(stored.uniqueRequestIdentifier, async (current) => relabel(current)),
		abortController: undefined,
	})
}

// Re-labels the stored run of the confirmation the dialog displays, whichever run it is; a published address-book change requests it.
export async function relabelDisplayedConfirmationSimulation(rpcNetwork: RpcNetwork) {
	await confirmationRelabelSemaphore.execute(async () => {
		const [displayed] = await getPendingTransactionsAndMessages()
		if (displayed === undefined) return
		await relabelStoredConfirmation(rpcNetwork, displayed, () => true)
	})
}

// The catch-up re-label of a confirmation workflow, which it requests for the run it just stored (storeConfirmationRun returns it). The re-label a change starts reaches only runs already stored, so a run whose lookups may have read the address book from before a change re-labels itself here, displayed or not, when the settled revision differs from the one it read when it started. It re-labels that run only, found by its request and run id; once a newer run replaced it, that run catches up itself. Awaited, so the workflow's following dialog update shows the new names.
export async function relabelStoredRunIfAddressBookChangedDuringIt(rpcNetwork: RpcNetwork, storedRun: StoredConfirmationRun | undefined) {
	if (storedRun === undefined) return
	// Read once the run is stored: a write stored later advances the revision after it, and its publication re-labels the stored run if it is displayed. However many changes were written during the run, this one re-label reads them all.
	if (storedRun.addressBookRevisionBeforeLookups === await getSettledAddressBookRevision()) return
	await relabelReportingUnexpectedErrors(confirmationRelabelSemaphore.execute(async () => {
		const stored = (await getPendingTransactionsAndMessages()).find((pending) => doesUniqueRequestIdentifiersMatch(pending.uniqueRequestIdentifier, storedRun.uniqueRequestIdentifier))
		if (stored === undefined) return
		await relabelStoredConfirmation(rpcNetwork, stored, (pending) => getStoredConfirmationRunId(pending) === storedRun.confirmationRunId)
	}))
}
