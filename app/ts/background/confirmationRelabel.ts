// Address-book re-labels of the displayed confirmation and their coordination with confirmation simulation runs; see "Address-book re-labels" in docs/popup-simulation-refresh.md.
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { TokenPriceService } from '../simulation/services/priceEstimator.js'
import type { PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import { NEW_BLOCK_ABORT } from '../utils/constants.js'
import { doesUniqueRequestIdentifiersMatch, type UniqueRequestIdentifier } from '../utils/requests.js'
import { Semaphore } from '../utils/semaphore.js'
import { modifyObject } from '../utils/typescript.js'
import { relabelStoredSimulation, type SimulationRunToRelabel } from './simulationRelabel.js'
import { getPendingTransactionsAndMessages, updatePendingTransactionOrMessage } from './storageVariables.js'

// Only a successful simulation of a pending transaction on the services' chain can be re-labelled: failed or still pending simulations show no names to re-label, and a run stored without a simulationId by an older version cannot be told apart from a newer run.
function getConfirmationRunToRelabel(pending: PendingTransactionOrSignableMessage, chainId: bigint): SimulationRunToRelabel<PendingTransactionOrSignableMessage> | undefined {
	if (pending.type !== 'Transaction' || pending.transactionOrMessageCreationStatus !== 'Simulated' || pending.popupVisualisation.statusCode !== 'success') return undefined
	const visualisation = pending.popupVisualisation.data
	if (visualisation.simulationId === undefined || visualisation.simulationState.rpcNetwork.chainId !== chainId) return undefined
	return {
		simulationId: visualisation.simulationId,
		simulationState: visualisation.simulationState,
		withMetadata: (metadata) => modifyObject(pending, { popupVisualisation: { statusCode: 'success', data: modifyObject(visualisation, metadata) } }),
	}
}

// One re-label at a time, so the last one requested reads the latest address book.
const confirmationRelabelSemaphore = new Semaphore(1)

// The confirmation re-label in progress; see cancelConfirmationRelabel.
let runningConfirmationRelabel: { readonly uniqueRequestIdentifier: UniqueRequestIdentifier, readonly abortController: AbortController } | undefined

// A new simulation run of a request replaces its stored run and reads the current address book itself, so it cancels a re-label of that request's stored run; simulations of other requests leave the re-label running.
export function cancelConfirmationRelabel(uniqueRequestIdentifier: UniqueRequestIdentifier) {
	if (runningConfirmationRelabel === undefined || !doesUniqueRequestIdentifiersMatch(runningConfirmationRelabel.uniqueRequestIdentifier, uniqueRequestIdentifier)) return
	runningConfirmationRelabel.abortController.abort(NEW_BLOCK_ABORT)
}

// Re-labels the stored run of the confirmation the dialog displays without simulating.
export async function relabelDisplayedConfirmationSimulation(ethereum: EthereumClientService, tokenPriceService: TokenPriceService) {
	await confirmationRelabelSemaphore.execute(async () => {
		const [displayed] = await getPendingTransactionsAndMessages()
		if (displayed === undefined) return
		const thisRelabel = { uniqueRequestIdentifier: displayed.uniqueRequestIdentifier, abortController: new AbortController() }
		runningConfirmationRelabel = thisRelabel
		try {
			const chainId = ethereum.getChainId()
			await relabelStoredSimulation(ethereum, tokenPriceService, {
				stored: displayed,
				getRunToRelabel: (pending) => getConfirmationRunToRelabel(pending, chainId),
				updateStored: async (relabel) => await updatePendingTransactionOrMessage(displayed.uniqueRequestIdentifier, async (current) => relabel(current)),
				abortController: thisRelabel.abortController,
			})
		} finally {
			runningConfirmationRelabel = undefined
		}
	})
}

// Counts address-book changes published in this background session; only publishAddressBookChangeAndRelabelSimulations records one, never a re-label.
let publishedAddressBookChanges = 0
export function recordPublishedAddressBookChange() {
	publishedAddressBookChanges += 1
}

// The re-label that follows an address-book change reaches only stored confirmations, and a confirmation run is stored by its caller after it returns. A run whose lookups overlap a published change may have read the old address book, so it does its lookups again; this also covers a request's first run, when there is no stored run to re-label yet.
export async function visualizeConfirmationWithLatestAddressBook<Visualized>(visualize: () => Promise<Visualized>) {
	let changesBeforeLookups: number
	let visualized: Visualized
	do {
		changesBeforeLookups = publishedAddressBookChanges
		visualized = await visualize()
	} while (changesBeforeLookups !== publishedAddressBookChanges)
	return visualized
}
