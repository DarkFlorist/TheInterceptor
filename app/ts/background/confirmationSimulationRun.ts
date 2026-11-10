import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { TokenPriceService } from '../simulation/services/priceEstimator.js'
import { getSignedTransactionForSimulation } from '../simulation/services/simulationTransactionSigning.js'
import type { ConfirmationRunId, ConfirmationSimulationRecord } from '../types/accessRequest.js'
import type { ErrorWithCodeAndOptionalData } from '../types/error.js'
import type { PreSimulationTransaction, SimulationStateInput, WebsiteCreatedEthereumTransaction } from '../types/visualizer-types.js'
import { JSON_RPC_ERROR_CODE_INTERNAL_ERROR, NEW_BLOCK_ABORT } from '../utils/constants.js'
import { decodeEthereumError } from '../utils/errorDecoding.js'
import { JsonRpcResponseError, isExpectedInfrastructureError, reportUnexpectedError } from '../utils/errors.js'
import { doesUniqueRequestIdentifiersMatch, type UniqueRequestIdentifier } from '../utils/requests.js'
import { sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { identifyAddress } from './metadataUtils.js'
import { getSimulationErrorAbis } from './simulationErrorAbi.js'
import { createSimulationStateWithNonceAndBaseFeeFixing, visualizeSimulatorState } from './simulationUpdating.js'
import { getTabState } from './storageVariables.js'

// The confirmation simulation runs that the confirmation window shows, whichever flow starts them: single transactions, Gnosis Safe confirmations and wallet_sendCalls batches. One run simulates at a time, run ids order the results a confirmation stores, and simulateConfirmationRun is the one protocol every flow runs and records a run with.

export const toPreSimulationTransaction = (transaction: WebsiteCreatedEthereumTransaction): PreSimulationTransaction => ({
	signedTransaction: getSignedTransactionForSimulation(transaction),
	website: transaction.website,
	created: transaction.created,
	originalRequestParameters: transaction.originalRequestParameters,
	transactionIdentifier: transaction.transactionIdentifier,
	...(transaction.simulationOptions === undefined ? {} : { simulationOptions: transaction.simulationOptions }),
})

let confirmTransactionAbortController = new AbortController()
export const getConfirmTransactionAbortController = () => confirmTransactionAbortController
// One confirmation simulation run: the request it simulates and the id it was handed out for that request. Flows pass it on as it is, so the run protocol never pairs an id with another request.
export type ConfirmationRun = { readonly uniqueRequestIdentifier: UniqueRequestIdentifier, readonly confirmationRunId: ConfirmationRunId }

// The confirmation simulation run that started simulating last, which owns confirmTransactionAbortController.
let runningConfirmationSimulation: ConfirmationRun | undefined

let latestConfirmationRunId: ConfirmationRunId = 0
// Every confirmation simulation run gets a new id, which the confirmation metadata refresh uses to tell the run it re-visualized from a newer one, and which keeps a newer stored run from being replaced by an older run that finishes later; stored timestamps keep only whole seconds, so they cannot. Callers take the id before the run reads the simulation stack or prepares its transactions, so a run with a newer id never works from older inputs. The id is the millisecond clock bumped past the previous id, so ids increase within a background session. Unlike the popup refresh generation it is not persisted, so ids stored before a background restart are not handed out again only as long as the system clock has not gone backwards.
function getNextConfirmationRunId() {
	latestConfirmationRunId = Math.max(latestConfirmationRunId + 1, Date.now())
	return latestConfirmationRunId
}

// Runs one confirmation simulation run of a request, which run ids are only handed out for. The id is taken here, the only place ids come from, before run starts, so run reads the simulation stack and prepares its transactions only once its id exists.
export async function runConfirmationSimulation<T>(uniqueRequestIdentifier: UniqueRequestIdentifier, run: (confirmationRun: ConfirmationRun) => Promise<T>): Promise<T> {
	return await run({ uniqueRequestIdentifier, confirmationRunId: getNextConfirmationRunId() })
}

// Each confirmation simulation supersedes the one still running, whose results would be stale by the time they arrive. A run is superseded itself when a newer run of the same confirmation has already started simulating, for example because this run's preparation took longer: it then starts nothing, aborts nothing and returns undefined.
function startConfirmTransactionSimulation(confirmationRun: ConfirmationRun) {
	if (runningConfirmationSimulation !== undefined
		&& runningConfirmationSimulation.confirmationRunId > confirmationRun.confirmationRunId
		&& doesUniqueRequestIdentifiersMatch(runningConfirmationSimulation.uniqueRequestIdentifier, confirmationRun.uniqueRequestIdentifier)
	) return undefined
	sendPopupMessageToOpenWindows({ method: 'popup_confirm_transaction_simulation_started' }, 'confirmTransaction')
	confirmTransactionAbortController.abort(NEW_BLOCK_ABORT)
	confirmTransactionAbortController = new AbortController()
	runningConfirmationSimulation = confirmationRun
	return confirmTransactionAbortController
}

export type ConfirmationSimulationRunRequest = {
	readonly ethereum: EthereumClientService
	readonly tokenPriceService: TokenPriceService
	readonly confirmationRun: ConfirmationRun
	readonly activeAddress: bigint
	readonly simulationMode: boolean
	// The flow-specific part of a run: the simulation input with the confirmation's transactions appended. It is read once the run has started, so a failure to build it is recorded like a failed simulation.
	readonly getSimulationInput: () => Promise<SimulationStateInput>
	// The contracts the confirmation calls, whose ABIs may decode a revert that the RPC reports.
	readonly calledContracts: readonly bigint[]
}

// Why a run failed: the RPC error of a simulation that failed or threw, and the block the failed simulation ran on. A run that threw has no simulation, so it records block 0, which the confirmation window shows as stale instead of naming a block that was never simulated.
type ConfirmationRunFailure = { readonly error: ErrorWithCodeAndOptionalData, readonly blockNumber: bigint }

// A thrown RPC error keeps its code, message and the revert data it reported. Any other error is internal and has no revert data.
const toThrownRunFailure = (error: unknown): ConfirmationRunFailure => ({
	error: error instanceof JsonRpcResponseError
		? { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) }
		: { code: JSON_RPC_ERROR_CODE_INTERNAL_ERROR, message: error instanceof Error ? error.message : 'Unknown simulation error' },
	blockNumber: 0n,
})

// Simulates and visualizes the flow's input. A simulation that failed or threw becomes a failure, and an interrupted one undefined.
async function simulateAndVisualize(request: ConfirmationSimulationRunRequest, abortController: AbortController) {
	try {
		const simulationState = await createSimulationStateWithNonceAndBaseFeeFixing(await request.getSimulationInput(), request.ethereum)
		const visualizedSimulatorState = await visualizeSimulatorState(simulationState, request.ethereum, request.tokenPriceService, abortController)
		const { visualizedSimulationState } = visualizedSimulatorState
		if (visualizedSimulationState.success === false) return { kind: 'failed' as const, failure: { error: visualizedSimulationState.jsonRpcError.error, blockNumber: visualizedSimulatorState.simulationState.blockNumber } }
		return { kind: 'visualized' as const, visualizedSimulatorState }
	} catch (error: unknown) {
		if (isExpectedInfrastructureError(error)) return undefined
		if (!(error instanceof JsonRpcResponseError)) await reportUnexpectedError(error, { code: 'confirm_transaction_simulation_failed' })
		return { kind: 'failed' as const, failure: toThrownRunFailure(error) }
	}
}

// Every failure, whether its simulation failed or threw, is decoded alike: revert data with the ABIs of the called contracts, and an error without revert data by its message.
async function decodeRunError(request: ConfirmationSimulationRunRequest, abortController: AbortController, error: ErrorWithCodeAndOptionalData) {
	const errorAbis: string[] = []
	for (const calledContract of new Set(request.calledContracts)) errorAbis.push(...await getSimulationErrorAbis(error.data ?? '0x', async () => await identifyAddress(request.ethereum, abortController, calledContract)))
	return decodeEthereumError(errorAbis, error).reason
}

// The protocol of one confirmation simulation run, which every flow runs: start the run, which supersedes the run in flight, simulate and visualize the flow's input, and record the outcome as a success or a failure. A superseded run, or one interrupted by a new block or an unreachable RPC, records nothing and returns undefined, so the stored preview stays in place.
export async function simulateConfirmationRun(request: ConfirmationSimulationRunRequest): Promise<ConfirmationSimulationRecord | undefined> {
	const { uniqueRequestIdentifier, confirmationRunId } = request.confirmationRun
	const signerName = (await getTabState(uniqueRequestIdentifier.requestSocket.tabId)).signerName
	const abortController = startConfirmTransactionSimulation(request.confirmationRun)
	if (abortController === undefined) return undefined
	const runData = { uniqueRequestIdentifier, simulationMode: request.simulationMode, activeAddress: request.activeAddress, signerName, simulationStartedTimestamp: new Date(), confirmationRunId }
	const outcome = await simulateAndVisualize(request, abortController)
	if (outcome === undefined) return undefined
	if (outcome.kind === 'visualized') return { statusCode: 'success', data: { ...runData, ...outcome.visualizedSimulatorState } }
	const { error, blockNumber } = outcome.failure
	try {
		const decodedErrorMessage = await decodeRunError(request, abortController, error)
		return { statusCode: 'failed', data: { ...runData, error: { ...error, decodedErrorMessage }, simulationState: { blockNumber, simulationConductedTimestamp: new Date() } } }
	} catch (decodingError: unknown) {
		if (isExpectedInfrastructureError(decodingError)) return undefined
		throw decodingError
	}
}
