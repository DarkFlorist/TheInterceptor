// Re-labels the displayed confirmation's stored run when the address book changes; addressBookChangePublication.ts requests it for each published change, and confirmationRunStorage.ts for each confirmation run stored after a change was published during it. See "Address-book re-labels" in docs/popup-simulation-refresh.md.
import type { PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import type { RpcNetwork } from '../types/rpc.js'
import { Semaphore } from '../utils/semaphore.js'
import { modifyObject } from '../utils/typescript.js'
import { relabelStoredSimulation, type SimulationRunToRelabel } from './simulationRelabel.js'
import { getPendingTransactionsAndMessages, updatePendingTransactionOrMessage } from './storageVariables.js'

// The id of the confirmation run a pending confirmation stores; every new run gets a new id, so the writer tells a new run from the stored one by it and a re-label writes only onto the run it read.
export const getStoredConfirmationRunId = (pending: PendingTransactionOrSignableMessage) => pending.type === 'Transaction' && (pending.transactionOrMessageCreationStatus === 'Simulated' || pending.transactionOrMessageCreationStatus === 'FailedToSimulate')
	? pending.popupVisualisation.data.confirmationRunId
	: undefined

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

// Re-labels the stored run of the confirmation the dialog displays without simulating. A newer simulation run of the request does not cancel it: the write guard in relabelStoredSimulation keeps it from replacing a run stored meanwhile, and a newer run that stores nothing, because it was aborted or its RPC request failed, leaves the re-labelled run in place.
export async function relabelDisplayedConfirmationSimulation(rpcNetwork: RpcNetwork) {
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
