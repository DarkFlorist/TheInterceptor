import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { appendTransactionsToInput } from '../simulation/services/SimulationModeEthereumClientService.js'
import { getSignedTransactionForSimulation } from '../simulation/services/simulationTransactionSigning.js'
import type { TokenPriceService } from '../simulation/services/priceEstimator.js'
import { createSafeExecutionPreSimulationTransaction, createSafeSigningSimulationInput } from '../safe/safeSimulation.js'
import type { ConfirmTransactionTransactionSingleVisualization, FailedTransactionPreview } from '../types/accessRequest.js'
import type { SafeTransactionSigningRequest } from '../types/safeTypes.js'
import type { WebsiteCreatedEthereumTransactionOrFailed } from '../types/visualizer-types.js'
import { last } from '../utils/array.js'
import { NEW_BLOCK_ABORT, JSON_RPC_ERROR_CODE_INTERNAL_ERROR } from '../utils/constants.js'
import { decodeEthereumError } from '../utils/errorDecoding.js'
import { JsonRpcResponseError, reportUnexpectedError, isExpectedInfrastructureError, isFailedToFetchError, isNewBlockAbort } from '../utils/errors.js'
import type { UniqueRequestIdentifier } from '../utils/requests.js'
import { sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { identifyAddress } from './metadataUtils.js'
import { getSimulationErrorAbis } from './simulationErrorAbi.js'
import { createSimulationStateWithNonceAndBaseFeeFixing, getCurrentSimulationInput, getFailedTransactionPreview, visualizeSimulatorState, withFailedTransactionPreview } from './simulationUpdating.js'
import { getInterceptorTransactionStack, getTabState } from './storageVariables.js'

let confirmTransactionAbortController = new AbortController()
export const getConfirmTransactionAbortController = () => confirmTransactionAbortController

let latestConfirmationSimulationId = 0
// Every confirmation simulation run gets a new id, which refreshPopupConfirmTransactionMetadata uses to tell the run whose metadata it refreshed from a newer one. As in bumpPopupRefreshGeneration, the id is the millisecond clock bumped past the previous id, so ids increase within a background session and ids stored before a background restart are not handed out again unless the system clock went backwards.
function getNextConfirmationSimulationId() {
	latestConfirmationSimulationId = Math.max(latestConfirmationSimulationId + 1, Date.now())
	return latestConfirmationSimulationId
}

// Missing names or ABIs must not hide why the transaction failed, so an RPC failure or a newer refresh interrupting the lookup leaves the failure view without a preview. Any other error is a defect and propagates.
async function tryGetFailedTransactionPreview(
	ethereum: EthereumClientService,
	requestAbortController: AbortController,
	transactionToSimulate: WebsiteCreatedEthereumTransactionOrFailed,
): Promise<FailedTransactionPreview | undefined> {
	try {
		return await getFailedTransactionPreview(ethereum, requestAbortController, transactionToSimulate)
	} catch (error: unknown) {
		if (isExpectedInfrastructureError(error)) return undefined
		throw error
	}
}

// Undefined when a newer refresh aborted this one, so the caller drops this outdated failure like any cancelled refresh instead of letting it replace the newer refresh's stored result. The signal is checked rather than the lookup error because the lookup can also finish from cached metadata without noticing the abort.
async function withFailedTransactionPreviewUnlessCancelled(
	ethereum: EthereumClientService,
	requestAbortController: AbortController,
	transactionToSimulate: WebsiteCreatedEthereumTransactionOrFailed,
	failure: ConfirmTransactionTransactionSingleVisualization,
): Promise<ConfirmTransactionTransactionSingleVisualization | undefined> {
	try {
		const failedTransactionPreview = await tryGetFailedTransactionPreview(ethereum, requestAbortController, transactionToSimulate)
		if (requestAbortController.signal.aborted) return undefined
		return failedTransactionPreview === undefined ? failure : withFailedTransactionPreview(failure, failedTransactionPreview)
	} catch (error: unknown) {
		// Every caller stores the failure returned here and none can store one that throws (the dialog opener turns any error into a rejection of the website's request), so a defective preview is reported at this boundary, as the catch below reports unexpected simulation errors, and the transaction's own failure is kept.
		await reportUnexpectedError(error, { code: 'failed_transaction_preview_failed' })
		return requestAbortController.signal.aborted ? undefined : failure
	}
}

export async function refreshConfirmTransactionSimulation(
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
		simulationId: getNextConfirmationSimulationId(),
	}
	sendPopupMessageToOpenWindows({ method: 'popup_confirm_transaction_simulation_started' }, 'confirmTransaction')
	confirmTransactionAbortController.abort(NEW_BLOCK_ABORT)
	confirmTransactionAbortController = new AbortController()
	const thisConfirmTransactionAbortController = confirmTransactionAbortController
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
