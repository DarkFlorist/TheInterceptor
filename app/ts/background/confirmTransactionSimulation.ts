import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { appendTransactionsToInput } from '../simulation/services/SimulationModeEthereumClientService.js'
import { getSignedTransactionForSimulation } from '../simulation/services/simulationTransactionSigning.js'
import type { TokenPriceService } from '../simulation/services/priceEstimator.js'
import { createSafeExecutionPreSimulationTransaction, createSafeSigningSimulationInput } from '../safe/safeSimulation.js'
import type { ConfirmationRunId, ConfirmTransactionTransactionSingleVisualization } from '../types/accessRequest.js'
import type { SafeTransactionSigningRequest } from '../types/safeTypes.js'
import type { SignerName } from '../types/signerTypes.js'
import type { WebsiteCreatedEthereumTransactionOrFailed } from '../types/visualizer-types.js'
import { last } from '../utils/array.js'
import { NEW_BLOCK_ABORT, JSON_RPC_ERROR_CODE_INTERNAL_ERROR } from '../utils/constants.js'
import { decodeEthereumError } from '../utils/errorDecoding.js'
import { JsonRpcResponseError, reportUnexpectedError, isFailedToFetchError, isNewBlockAbort } from '../utils/errors.js'
import { type UniqueRequestIdentifier, getUniqueRequestIdentifierString } from '../utils/requests.js'
import { sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { identifyAddress } from './metadataUtils.js'
import { getSimulationErrorAbis } from './simulationErrorAbi.js'
import { createSimulationStateWithNonceAndBaseFeeFixing, getCurrentSimulationInput, visualizeSimulatorState } from './simulationUpdating.js'
import { getInterceptorTransactionStack, getTabState } from './storageVariables.js'

// Every confirmation simulation run gets an id that orders it against the other runs of its request: the random id of this background lifetime and the run's place among this lifetime's runs. Stored timestamps keep only whole seconds, so they cannot. Issuing an id reads neither storage nor the clock, so reserving one cannot fail.
const confirmationRunLifetime = crypto.randomUUID()
let latestConfirmationRunSequence = 0

// Reserves the next run id synchronously, so every entry that starts a confirmation run calls it before its first await, and a run that starts first gets the earlier id. A reservation that its entry ends up not using only skips a sequence number.
export function reserveConfirmationRun(): ConfirmationRunId {
	latestConfirmationRunSequence += 1
	return { lifetime: confirmationRunLifetime, sequence: latestConfirmationRunSequence }
}

type InFlightConfirmationRun = { readonly sequence: number, readonly abortController: AbortController }

// The run in flight for each confirmation request, keyed by its request. A run aborts only the run of its own request that it replaces, and a run that resumes after a later run of its request was installed ends as an aborted run does, so an earlier run never aborts a later one. Runs of different requests never cancel each other, so a run never leaves another confirmation without the run that completes it. An entry is removed when its run finishes, so only runs in flight are kept.
const inFlightConfirmationRuns = new Map<string, InFlightConfirmationRun>()

// The abort controller of the run in flight for the request, if any, for work that is outdated once a later run of that request starts.
export const getInFlightConfirmationRunAbortController = (uniqueRequestIdentifier: UniqueRequestIdentifier) => inFlightConfirmationRuns.get(getUniqueRequestIdentifierString(uniqueRequestIdentifier))?.abortController

export async function refreshConfirmTransactionSimulation(
	confirmationRunId: ConfirmationRunId,
	ethereum: EthereumClientService,
	tokenPriceService: TokenPriceService,
	activeAddress: bigint,
	simulationMode: boolean,
	uniqueRequestIdentifier: UniqueRequestIdentifier,
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
		confirmationRunId,
	}
	const requestKey = getUniqueRequestIdentifierString(uniqueRequestIdentifier)
	const replacedRun = inFlightConfirmationRuns.get(requestKey)
	if (replacedRun !== undefined && replacedRun.sequence > confirmationRunId.sequence) return undefined
	replacedRun?.abortController.abort(NEW_BLOCK_ABORT)
	const thisRun = { sequence: confirmationRunId.sequence, abortController: new AbortController() }
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
	readonly confirmationRunId: ConfirmationRunId
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
						transactionIdentifier: transactionToSimulate.transactionIdentifier,
						...(transactionToSimulate.simulationOptions === undefined ? {} : { simulationOptions: transactionToSimulate.simulationOptions }),
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
