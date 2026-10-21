import { getSignedTransactionForSimulation } from '../simulation/services/simulationTransactionSigning.js'
import type { PreSimulationTransaction, WebsiteCreatedEthereumTransaction } from '../types/visualizer-types.js'
import { NEW_BLOCK_ABORT } from '../utils/constants.js'
import { doesUniqueRequestIdentifiersMatch, type UniqueRequestIdentifier } from '../utils/requests.js'
import { sendPopupMessageToOpenWindows } from './backgroundUtils.js'

// The confirmation simulation runs that the confirmation window shows, whichever flow starts them: single transactions, Gnosis Safe confirmations and wallet_sendCalls batches. One run simulates at a time, and run ids order the results a confirmation stores.

export const toPreSimulationTransaction = (transaction: WebsiteCreatedEthereumTransaction): PreSimulationTransaction => ({
	signedTransaction: getSignedTransactionForSimulation(transaction),
	website: transaction.website,
	created: transaction.created,
	originalRequestParameters: transaction.originalRequestParameters,
	transactionIdentifier: transaction.transactionIdentifier,
})

let confirmTransactionAbortController = new AbortController()
export const getConfirmTransactionAbortController = () => confirmTransactionAbortController
// The confirmation simulation run that started simulating last, which owns confirmTransactionAbortController.
let runningConfirmationSimulation: { readonly uniqueRequestIdentifier: UniqueRequestIdentifier, readonly confirmationRunId: number } | undefined

let latestConfirmationRunId = 0
// Every confirmation simulation run gets a new id, which the confirmation metadata refresh uses to tell the run it re-visualized from a newer one, and which keeps a newer stored run from being replaced by an older run that finishes later; stored timestamps keep only whole seconds, so they cannot. Callers take the id before the run reads the simulation stack or prepares its transactions, so a run with a newer id never works from older inputs. The id is the millisecond clock bumped past the previous id, so ids increase within a background session. Unlike the popup refresh generation it is not persisted, so ids stored before a background restart are not handed out again only as long as the system clock has not gone backwards.
function getNextConfirmationRunId() {
	latestConfirmationRunId = Math.max(latestConfirmationRunId + 1, Date.now())
	return latestConfirmationRunId
}

// Runs one confirmation simulation run, which run ids are only handed out for. The id is taken here, before run starts, so run reads the simulation stack and prepares its transactions only once its id exists.
export async function runConfirmationSimulation<T>(run: (confirmationRunId: number) => Promise<T>): Promise<T> {
	return await run(getNextConfirmationRunId())
}

// Each confirmation simulation supersedes the one still running, whose results would be stale by the time they arrive. A run is superseded itself when a newer run of the same confirmation has already started simulating, for example because this run's preparation took longer: it then starts nothing, aborts nothing and returns undefined.
export function startConfirmTransactionSimulation(uniqueRequestIdentifier: UniqueRequestIdentifier, confirmationRunId: number) {
	if (runningConfirmationSimulation !== undefined
		&& runningConfirmationSimulation.confirmationRunId > confirmationRunId
		&& doesUniqueRequestIdentifiersMatch(runningConfirmationSimulation.uniqueRequestIdentifier, uniqueRequestIdentifier)
	) return undefined
	sendPopupMessageToOpenWindows({ method: 'popup_confirm_transaction_simulation_started' }, 'confirmTransaction')
	confirmTransactionAbortController.abort(NEW_BLOCK_ABORT)
	confirmTransactionAbortController = new AbortController()
	runningConfirmationSimulation = { uniqueRequestIdentifier, confirmationRunId }
	return confirmTransactionAbortController
}
