import { createSafeExecutionPreSimulationTransaction, createSafeSigningSimulationInput } from '../safe/safeSimulation.js'
import { appendTransactionsToInput } from '../simulation/services/SimulationModeEthereumClientService.js'
import { getSignedTransactionForSimulation } from '../simulation/services/simulationTransactionSigning.js'
import type { ConfirmationRunId, ConfirmTransactionTransactionSingleVisualization } from '../types/accessRequest.js'
import type { SafeTransactionSigningRequest } from '../types/safeTypes.js'
import type { SignerName } from '../types/signerTypes.js'
import type { WebsiteCreatedEthereumTransactionOrFailed } from '../types/visualizer-types.js'
import { last } from '../utils/array.js'
import { JSON_RPC_ERROR_CODE_INTERNAL_ERROR, NEW_BLOCK_ABORT } from '../utils/constants.js'
import { decodeEthereumError } from '../utils/errorDecoding.js'
import { isFailedToFetchError, isNewBlockAbort, JsonRpcResponseError, reportUnexpectedError } from '../utils/errors.js'
import type { UniqueRequestIdentifier } from '../utils/requests.js'
import { sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { identifyAddress } from './metadataUtils.js'
import type { SimulationSnapshot } from './networkTransitionLock.js'
import { getSimulationErrorAbis } from './simulationErrorAbi.js'
import { createSimulationStateWithNonceAndBaseFeeFixing, visualizeSimulatorState, withFailedTransactionPreviewUnlessCancelled } from './simulationUpdating.js'
import { getTabState } from './storageVariables.js'

let confirmTransactionAbortController = new AbortController()
export const getConfirmTransactionAbortController = () => confirmTransactionAbortController

// Every confirmation simulation run gets an id no other run ever has, which refreshPopupConfirmTransactionMetadata uses to tell the run whose metadata it refreshed from any other. The sequence numbers the runs of this background lifetime and starts over after a restart, and the random lifetime keeps a run of this lifetime from taking the id of a run stored before the restart. The id reads neither the clock nor storage. See "Confirmation dialog staleness" in docs/popup-simulation-refresh.md for how this id, the simulation timestamp and the metadata refresh counter divide the work.
const confirmationRunLifetime = crypto.randomUUID()
let latestConfirmationRunSequence = 0

function getNextConfirmationRunId(): ConfirmationRunId {
	latestConfirmationRunSequence += 1
	return { lifetime: confirmationRunLifetime, sequence: latestConfirmationRunSequence }
}

// The result stored for a confirmation's first simulation when the run ended without one (refreshConfirmTransactionSimulation returned undefined because it was aborted or its RPC fetch failed). A failed result is what confirmation refreshes simulate again, and the window shows it as "Failed to simulate. Retrying...".
export function createInterruptedConfirmTransactionSimulation(
	activeAddress: bigint,
	simulationMode: boolean,
	uniqueRequestIdentifier: UniqueRequestIdentifier,
	transactionToSimulate: WebsiteCreatedEthereumTransactionOrFailed,
	signerName: SignerName,
	simulationStartedTimestamp: Date,
): ConfirmTransactionTransactionSingleVisualization {
	const message = 'The simulation was interrupted before it finished.'
	return { statusCode: 'failed', data: {
		uniqueRequestIdentifier,
		transactionToSimulate,
		simulationMode,
		activeAddress,
		signerName,
		confirmationRunId: getNextConfirmationRunId(),
		simulationStartedTimestamp,
		error: { code: JSON_RPC_ERROR_CODE_INTERNAL_ERROR, message, decodedErrorMessage: message },
		simulationState: {
			blockNumber: 0n,
			simulationConductedTimestamp: new Date(),
		},
	} }
}

export async function refreshConfirmTransactionSimulation(
	simulation: SimulationSnapshot,
	activeAddress: bigint,
	simulationMode: boolean,
	uniqueRequestIdentifier: UniqueRequestIdentifier,
	transactionToSimulate: WebsiteCreatedEthereumTransactionOrFailed,
	safeSigningRequest?: SafeTransactionSigningRequest,
): Promise<ConfirmTransactionTransactionSingleVisualization | undefined> {
	const { ethereum, tokenPriceService } = simulation.services
	// Replace the controller before the first await so an older run resuming late can never abort a newer run's simulation
	confirmTransactionAbortController.abort(NEW_BLOCK_ABORT)
	confirmTransactionAbortController = new AbortController()
	const thisConfirmTransactionAbortController = confirmTransactionAbortController
	const info = {
		uniqueRequestIdentifier,
		transactionToSimulate,
		simulationMode,
		activeAddress,
		signerName: (await getTabState(uniqueRequestIdentifier.requestSocket.tabId)).signerName,
		tabIdOpenedFrom: uniqueRequestIdentifier.requestSocket.tabId,
		confirmationRunId: getNextConfirmationRunId(),
	}
	sendPopupMessageToOpenWindows({ method: 'popup_confirm_transaction_simulation_started' }, 'confirmTransaction')
	const simulationStartedTimestamp = new Date()
	const simulationInput = safeSigningRequest === undefined
		? simulation.simulationStateInput
		: createSafeSigningSimulationInput(simulation.interceptorTransactionStack, safeSigningRequest)
	try {
		const getNewVisualizedSimulationState = async () => {
			const preSimulationTransaction = transactionToSimulate.success
				? safeSigningRequest === undefined
					? {
						signedTransaction: getSignedTransactionForSimulation(transactionToSimulate),
						website: transactionToSimulate.website,
						created: transactionToSimulate.created,
						originalRequestParameters: transactionToSimulate.originalRequestParameters,
						transactionIdentifier: transactionToSimulate.transactionIdentifier,
						...(transactionToSimulate.simulationOptions === undefined ? {} : { simulationOptions: transactionToSimulate.simulationOptions }),
					}
					: createSafeExecutionPreSimulationTransaction(transactionToSimulate, safeSigningRequest)
				: undefined
			const simulationStateWithNewTransaction = preSimulationTransaction === undefined
				? simulationInput
				: appendTransactionsToInput(simulationInput, [preSimulationTransaction])
			const updatedSimulationState = await createSimulationStateWithNonceAndBaseFeeFixing(simulationStateWithNewTransaction, ethereum)
			return await visualizeSimulatorState(updatedSimulationState, ethereum, tokenPriceService, thisConfirmTransactionAbortController)
		}
		const visualizedSimulatorState = await getNewVisualizedSimulationState()
		const availableAbis = visualizedSimulatorState.addressBookEntries
			.map((entry) => 'abi' in entry && entry.abi !== undefined ? entry.abi : undefined)
			.filter((abiOrUndefined): abiOrUndefined is string => abiOrUndefined !== undefined)
		if (visualizedSimulatorState.visualizedSimulationState.success === false) {
			return await withFailedTransactionPreviewUnlessCancelled(ethereum, thisConfirmTransactionAbortController, transactionToSimulate, { statusCode: 'failed', data: {
				...info,
				simulationStartedTimestamp,
				error: { ...visualizedSimulatorState.visualizedSimulationState.jsonRpcError.error, decodedErrorMessage: visualizedSimulatorState.visualizedSimulationState.jsonRpcError.error.message },
				simulationState: {
					blockNumber: visualizedSimulatorState.simulationState.blockNumber,
					simulationConductedTimestamp: new Date(),
				}
			} })
		}
		const blocks = visualizedSimulatorState.visualizedSimulationState.visualizedBlocks
		const lastTransaction = last(last(blocks)?.simulatedAndVisualizedTransactions ?? [])
		const confirmation: ConfirmTransactionTransactionSingleVisualization = {
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
		return transactionToSimulate.success ? confirmation : await withFailedTransactionPreviewUnlessCancelled(ethereum, thisConfirmTransactionAbortController, transactionToSimulate, confirmation)
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
		return await withFailedTransactionPreviewUnlessCancelled(ethereum, thisConfirmTransactionAbortController, transactionToSimulate, { statusCode: 'failed', data: {
			...info,
			simulationStartedTimestamp,
			error: { ...baseError, decodedErrorMessage: isJsonRpcResponseError ? decodeEthereumError(await extractToAbi(), baseError).reason : baseError.message },
			simulationState: {
				blockNumber: 0n,
				simulationConductedTimestamp: new Date()
			}
		} })
	}
}
