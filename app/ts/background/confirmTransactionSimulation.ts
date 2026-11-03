import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { appendTransactionsToInput } from '../simulation/services/SimulationModeEthereumClientService.js'
import { getSignedTransactionForSimulation } from '../simulation/services/simulationTransactionSigning.js'
import type { TokenPriceService } from '../simulation/services/priceEstimator.js'
import { createSafeExecutionPreSimulationTransaction, createSafeSigningSimulationInput } from '../safe/safeSimulation.js'
import { CONFIRMATION_RUN_ID_OF_UNNUMBERED_RUN, type ConfirmTransactionTransactionSingleVisualization, type PendingTransaction } from '../types/accessRequest.js'
import type { SafeTransactionSigningRequest } from '../types/safeTypes.js'
import type { SignerName } from '../types/signerTypes.js'
import type { WebsiteCreatedEthereumTransactionOrFailed } from '../types/visualizer-types.js'
import { last } from '../utils/array.js'
import { stringifyJSONWithBigInts } from '../utils/bigint.js'
import { NEW_BLOCK_ABORT, JSON_RPC_ERROR_CODE_INTERNAL_ERROR } from '../utils/constants.js'
import { decodeEthereumError } from '../utils/errorDecoding.js'
import { JsonRpcResponseError, reportUnexpectedError, isFailedToFetchError, isNewBlockAbort } from '../utils/errors.js'
import { type UniqueRequestIdentifier, getUniqueRequestIdentifierString, silenceChromeUnCaughtPromise } from '../utils/requests.js'
import { sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { identifyAddress } from './metadataUtils.js'
import { getSimulationErrorAbis } from './simulationErrorAbi.js'
import { createSimulationStateWithNonceAndBaseFeeFixing, getCurrentSimulationInput, visualizeSimulatorState } from './simulationUpdating.js'
import { getInterceptorTransactionStack, getPendingTransactionsAndMessages, getTabState } from './storageVariables.js'

let latestConfirmationRunId = 0
// The highest run id among the stored confirmations, including those stored before the background last restarted; 0 when none has one.
async function getHighestStoredConfirmationRunId() {
	const storedRunIds = (await getPendingTransactionsAndMessages()).flatMap((pending) => pending.type === 'Transaction' && 'popupVisualisation' in pending ? [pending.popupVisualisation.data.confirmationRunId] : [])
	return Math.max(CONFIRMATION_RUN_ID_OF_UNNUMBERED_RUN, ...storedRunIds)
}

// Every confirmation simulation run gets a new id, which orders it against the stored runs; stored timestamps keep only whole seconds, so they cannot. The id is the millisecond clock bumped past both the previous id and every stored id. So ids increase within a background lifetime, and a new run is also later than every run stored before a restart, even if the system clock went back meanwhile. Ids are positive, so none is the run 0 that a visualisation stored without a run id decodes as. The allocations run one at a time, in the order runs reserve them, because each reads the stored ids first: an allocation whose read is slow would otherwise get a higher id than a run that started after it.
let confirmationRunIdAllocations: Promise<unknown> = Promise.resolve()

// A confirmation run's place in the run order, taken when the run starts and handed to refreshConfirmTransactionSimulation.
export type ConfirmationRunReservation = { readonly runId: Promise<number> }

// Reserves the next run id synchronously when called, so every entry that starts a confirmation run calls it before its first await, and a run that starts first gets the lower id. The id rejects only for this run if its read of the stored ids fails; the next allocation still runs. A reservation that its entry ends up not using only skips an id.
export function reserveConfirmationRun(): ConfirmationRunReservation {
	const allocation = confirmationRunIdAllocations.then(async () => {
		const highestStoredRunId = await getHighestStoredConfirmationRunId()
		latestConfirmationRunId = Math.max(latestConfirmationRunId + 1, highestStoredRunId + 1, Date.now())
		return latestConfirmationRunId
	})
	confirmationRunIdAllocations = allocation.then(() => undefined, () => undefined)
	return { runId: silenceChromeUnCaughtPromise(allocation) }
}

type InFlightConfirmationRun = { readonly runId: number, readonly abortController: AbortController }

// The run in flight for each confirmation request, keyed by its request. A run aborts only the run of its own request that it replaces, and a run that resumes after a later run of its request was installed ends as an aborted run does, so an earlier run never aborts a later one. Runs of different requests never cancel each other, so a run never leaves another confirmation without the run that completes it. An entry is removed when its run finishes, so only runs in flight are kept.
const inFlightConfirmationRuns = new Map<string, InFlightConfirmationRun>()

// The abort controller of the run in flight for the request, if any, for work that is outdated once a later run of that request starts.
export const getInFlightConfirmationRunAbortController = (uniqueRequestIdentifier: UniqueRequestIdentifier) => inFlightConfirmationRuns.get(getUniqueRequestIdentifierString(uniqueRequestIdentifier))?.abortController

type ConfirmationRunVisualisation = { readonly data: { readonly confirmationRunId: number } }

// The one rule for whether a confirmation visualisation may be stored over the stored one. A new run, stored with the transaction it prepared, replaces the stored visualisation unless that came from a later run; a re-visualisation of a stored run's results, stored without a transaction, needs that run to still be stored, so the visualisation stays paired with the transaction the run prepared. Runs are ordered by their ids, which reserveConfirmationRun issues in the order runs start and above every stored id, so a preview stored before a restart never blocks a new run, while of two overlapping runs the one started first stays the older. It answers which confirmation run is current, unlike the fingerprints in popupSimulationFingerprint.ts, which tell whether the inputs of the popup's own simulation changed.
export function isConfirmationVisualisationCurrent(stored: ConfirmationRunVisualisation | undefined, candidate: ConfirmationRunVisualisation, candidateKind: 'new run' | 're-visualised run') {
	if (stored === undefined) return candidateKind === 'new run'
	if (candidateKind === 're-visualised run') return candidate.data.confirmationRunId === stored.data.confirmationRunId
	return candidate.data.confirmationRunId >= stored.data.confirmationRunId
}

// What a new run prepares the transaction from. A run whose inputs changed while it ran, for example through a gas limit edit or a Gnosis Safe signer change, describes a transaction that is no longer stored, so it is not current whatever its run id.
export const getConfirmationRunInputs = (pendingTransaction: PendingTransaction) => stringifyJSONWithBigInts([pendingTransaction.originalRequestParameters, pendingTransaction.activeAddress, pendingTransaction.safeTransaction])

export async function refreshConfirmTransactionSimulation(
	reservation: ConfirmationRunReservation,
	ethereum: EthereumClientService,
	tokenPriceService: TokenPriceService,
	activeAddress: bigint,
	simulationMode: boolean,
	uniqueRequestIdentifier: UniqueRequestIdentifier,
	transactionToSimulate: WebsiteCreatedEthereumTransactionOrFailed,
	safeSigningRequest?: SafeTransactionSigningRequest,
): Promise<ConfirmTransactionTransactionSingleVisualization | undefined> {
	const confirmationRunId = await reservation.runId
	const info = {
		uniqueRequestIdentifier,
		transactionToSimulate,
		simulationMode,
		activeAddress,
		signerName: (await getTabState(uniqueRequestIdentifier.requestSocket.tabId)).signerName,
		tabIdOpenedFrom: uniqueRequestIdentifier.requestSocket.tabId,
		confirmationRunId,
	}
	const requestKey = getUniqueRequestIdentifierString(uniqueRequestIdentifier)
	const replacedRun = inFlightConfirmationRuns.get(requestKey)
	if (replacedRun !== undefined && replacedRun.runId > confirmationRunId) return undefined
	replacedRun?.abortController.abort(NEW_BLOCK_ABORT)
	const thisRun = { runId: confirmationRunId, abortController: new AbortController() }
	inFlightConfirmationRuns.set(requestKey, thisRun)
	try {
		return await simulateConfirmationRun(ethereum, tokenPriceService, info, thisRun.abortController, safeSigningRequest)
	} finally {
		if (inFlightConfirmationRuns.get(requestKey) === thisRun) inFlightConfirmationRuns.delete(requestKey)
	}
}

type ConfirmationRunInfo = {
	readonly uniqueRequestIdentifier: UniqueRequestIdentifier
	readonly transactionToSimulate: WebsiteCreatedEthereumTransactionOrFailed
	readonly simulationMode: boolean
	readonly activeAddress: bigint
	readonly signerName: SignerName
	readonly tabIdOpenedFrom: number
	readonly confirmationRunId: number
}

async function simulateConfirmationRun(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, info: ConfirmationRunInfo, thisConfirmTransactionAbortController: AbortController, safeSigningRequest: SafeTransactionSigningRequest | undefined): Promise<ConfirmTransactionTransactionSingleVisualization | undefined> {
	const { transactionToSimulate } = info
	sendPopupMessageToOpenWindows({ method: 'popup_confirm_transaction_simulation_started' }, 'confirmTransaction')
	const simulationStartedTimestamp = new Date()
	const simulationInput = safeSigningRequest === undefined
		? await getCurrentSimulationInput()
		: createSafeSigningSimulationInput(await getInterceptorTransactionStack(), safeSigningRequest)
	try {
		const getNewVisualizedSimulationState = async () => {
			const preSimulationTransaction = transactionToSimulate.success
				? safeSigningRequest === undefined
					? {
						signedTransaction: getSignedTransactionForSimulation(transactionToSimulate),
						website: transactionToSimulate.website,
						created: transactionToSimulate.created,
						originalRequestParameters: transactionToSimulate.originalRequestParameters,
						transactionIdentifier: transactionToSimulate.transactionIdentifier
					}
					: createSafeExecutionPreSimulationTransaction(transactionToSimulate, safeSigningRequest)
				: undefined
			const simulationStateWithNewTransaction = preSimulationTransaction === undefined
				? simulationInput
				: appendTransactionsToInput(simulationInput, [preSimulationTransaction], undefined, {}, safeSigningRequest !== undefined)
			const updatedSimulationState = await createSimulationStateWithNonceAndBaseFeeFixing(simulationStateWithNewTransaction, ethereum)
			return await visualizeSimulatorState(updatedSimulationState, ethereum, tokenPriceService, thisConfirmTransactionAbortController)
		}
		const visualizedSimulatorState = await getNewVisualizedSimulationState()
		const availableAbis = visualizedSimulatorState.addressBookEntries
			.map((entry) => 'abi' in entry && entry.abi !== undefined ? entry.abi : undefined)
			.filter((abiOrUndefined): abiOrUndefined is string => abiOrUndefined !== undefined)
		if (visualizedSimulatorState.visualizedSimulationState.success === false) {
			return { statusCode: 'failed', data: {
				...info,
				simulationStartedTimestamp,
				error: { ...visualizedSimulatorState.visualizedSimulationState.jsonRpcError.error, decodedErrorMessage: visualizedSimulatorState.visualizedSimulationState.jsonRpcError.error.message },
				simulationState: {
					blockNumber: visualizedSimulatorState.simulationState.blockNumber,
					simulationConductedTimestamp: new Date(),
				}
			} }
		}
		const blocks = visualizedSimulatorState.visualizedSimulationState.visualizedBlocks
		const lastTransaction = last(last(blocks)?.simulatedAndVisualizedTransactions ?? [])
		return {
			statusCode: 'success',
			data: {
				...info,
				simulationStartedTimestamp,
				...visualizedSimulatorState,
				transactionToSimulate: {
					...transactionToSimulate,
					...transactionToSimulate.success ? {
						transaction: {
							...transactionToSimulate.transaction,
							nonce: lastTransaction ? lastTransaction.transaction.nonce : transactionToSimulate.transaction.nonce,
						} }
					: { error: {
						...transactionToSimulate.error,
						decodedErrorMessage: decodeEthereumError(availableAbis, transactionToSimulate.error).reason
					} }
				}
			}
		}
	} catch (error) {
		if (isNewBlockAbort(error)) return undefined
		if (isFailedToFetchError(error)) return undefined
		const isJsonRpcResponseError = error instanceof JsonRpcResponseError
		if (!isJsonRpcResponseError) await reportUnexpectedError(error, { code: 'confirm_transaction_simulation_failed' })

		const baseError = isJsonRpcResponseError
			? { code: error.code, message: error.message, data: typeof error.data === 'string' ? error.data : '0x' }
			: { code: JSON_RPC_ERROR_CODE_INTERNAL_ERROR, message: error instanceof Error ? error.message : 'Unknown simulation error', data: '0x' }
		const extractToAbi = async (): Promise<readonly string[]> => {
			const params = transactionToSimulate.originalRequestParameters.params[0]
			if (!('to' in params)) return []
			if (params.to === undefined || params.to === null) return []
			const recipient = params.to
			return await getSimulationErrorAbis(baseError.data, async () => await identifyAddress(ethereum, thisConfirmTransactionAbortController, recipient))
		}
		return { statusCode: 'failed', data: {
			...info,
			simulationStartedTimestamp,
			error: { ...baseError, decodedErrorMessage: isJsonRpcResponseError ? decodeEthereumError(await extractToAbi(), baseError).reason : baseError.message },
			simulationState: {
				blockNumber: 0n,
				simulationConductedTimestamp: new Date()
			}
		} }
	}
}
