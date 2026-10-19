import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { appendTransactionsToInput } from '../simulation/services/SimulationModeEthereumClientService.js'
import { getSignedTransactionForSimulation } from '../simulation/services/simulationTransactionSigning.js'
import type { TokenPriceService } from '../simulation/services/priceEstimator.js'
import { createSafeExecutionPreSimulationTransaction, createSafeSigningSimulationInput } from '../safe/safeSimulation.js'
import type { ConfirmTransactionTransactionSingleVisualization } from '../types/accessRequest.js'
import type { SafeTransactionSigningRequest } from '../types/safeTypes.js'
import type { PreSimulationTransaction, WebsiteCreatedEthereumTransaction, WebsiteCreatedEthereumTransactionOrFailed } from '../types/visualizer-types.js'
import { last } from '../utils/array.js'
import { NEW_BLOCK_ABORT, JSON_RPC_ERROR_CODE_INTERNAL_ERROR } from '../utils/constants.js'
import { decodeEthereumError } from '../utils/errorDecoding.js'
import { JsonRpcResponseError, reportUnexpectedError, isFailedToFetchError, isNewBlockAbort } from '../utils/errors.js'
import { doesUniqueRequestIdentifiersMatch, type UniqueRequestIdentifier } from '../utils/requests.js'
import { sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { identifyAddress } from './metadataUtils.js'
import { getSimulationErrorAbis } from './simulationErrorAbi.js'
import { createSimulationStateWithNonceAndBaseFeeFixing, getCurrentSimulationInput, visualizeSimulatorState } from './simulationUpdating.js'
import { getInterceptorTransactionStack, getTabState } from './storageVariables.js'

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
let runningConfirmationSimulation: { readonly uniqueRequestIdentifier: UniqueRequestIdentifier, readonly simulationId: number } | undefined

let latestConfirmationSimulationId = 0
// Every confirmation simulation run gets a new id, which the confirmation metadata refresh uses to tell the run it re-visualized from a newer one, and which keeps a newer stored run from being replaced by an older run that finishes later; stored timestamps keep only whole seconds, so they cannot. Callers take the id before the run reads the simulation stack or prepares its transactions, so a run with a newer id never works from older inputs. As in bumpPopupRefreshGeneration, the id is the millisecond clock bumped past the previous id, so ids increase within a background session and ids stored before a background restart are not handed out again unless the system clock went backwards.
export function getNextConfirmationSimulationId() {
	latestConfirmationSimulationId = Math.max(latestConfirmationSimulationId + 1, Date.now())
	return latestConfirmationSimulationId
}

// Each confirmation simulation supersedes the one still running, whose results would be stale by the time they arrive. A run is superseded itself when a newer run of the same confirmation has already started simulating, for example because this run's preparation took longer: it then starts nothing, aborts nothing and returns undefined.
export function startConfirmTransactionSimulation(uniqueRequestIdentifier: UniqueRequestIdentifier, simulationId: number) {
	if (runningConfirmationSimulation !== undefined
		&& runningConfirmationSimulation.simulationId > simulationId
		&& doesUniqueRequestIdentifiersMatch(runningConfirmationSimulation.uniqueRequestIdentifier, uniqueRequestIdentifier)
	) return undefined
	sendPopupMessageToOpenWindows({ method: 'popup_confirm_transaction_simulation_started' }, 'confirmTransaction')
	confirmTransactionAbortController.abort(NEW_BLOCK_ABORT)
	confirmTransactionAbortController = new AbortController()
	runningConfirmationSimulation = { uniqueRequestIdentifier, simulationId }
	return confirmTransactionAbortController
}

export async function refreshConfirmTransactionSimulation(
	ethereum: EthereumClientService,
	tokenPriceService: TokenPriceService,
	activeAddress: bigint,
	simulationMode: boolean,
	uniqueRequestIdentifier: UniqueRequestIdentifier,
	simulationId: number,
	transactionToSimulate: WebsiteCreatedEthereumTransactionOrFailed,
	safeSigningRequest?: SafeTransactionSigningRequest,
): Promise<ConfirmTransactionTransactionSingleVisualization | undefined> {
	const info = {
		uniqueRequestIdentifier,
		transactionToSimulate,
		simulationMode,
		activeAddress,
		signerName: (await getTabState(uniqueRequestIdentifier.requestSocket.tabId)).signerName,
		tabIdOpenedFrom: uniqueRequestIdentifier.requestSocket.tabId,
		simulationId,
	}
	const thisConfirmTransactionAbortController = startConfirmTransactionSimulation(uniqueRequestIdentifier, simulationId)
	if (thisConfirmTransactionAbortController === undefined) return undefined
	const simulationStartedTimestamp = new Date()
	const simulationInput = safeSigningRequest === undefined
		? await getCurrentSimulationInput()
		: createSafeSigningSimulationInput(await getInterceptorTransactionStack(), safeSigningRequest)
	try {
		const getNewVisualizedSimulationState = async () => {
			const preSimulationTransaction = transactionToSimulate.success
				? safeSigningRequest === undefined
					? toPreSimulationTransaction(transactionToSimulate)
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
