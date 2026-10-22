import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { appendTransactionsToInput } from '../simulation/services/SimulationModeEthereumClientService.js'
import { getSignedTransactionForSimulation } from '../simulation/services/simulationTransactionSigning.js'
import type { TokenPriceService } from '../simulation/services/priceEstimator.js'
import { createSafeExecutionPreSimulationTransaction, createSafeSigningSimulationInput } from '../safe/safeSimulation.js'
import { getFailureReasonForDisplay } from '../simulation/failureReasons.js'
import { appendProtocolRevertReasonHints } from '../simulation/revertReasonHints.js'
import type { ConfirmTransactionTransactionSingleVisualization } from '../types/accessRequest.js'
import type { SafeTransactionSigningRequest } from '../types/safeTypes.js'
import type { WebsiteCreatedEthereumTransactionOrFailed } from '../types/visualizer-types.js'
import { last } from '../utils/array.js'
import { NEW_BLOCK_ABORT, JSON_RPC_ERROR_CODE_INTERNAL_ERROR } from '../utils/constants.js'
import { JsonRpcResponseError, reportUnexpectedError, isFailedToFetchError, isNewBlockAbort } from '../utils/errors.js'
import type { UniqueRequestIdentifier } from '../utils/requests.js'
import { sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { identifyAddress } from './metadataUtils.js'
import { getErrorDecodingAbis } from './errorDecodingAbis.js'
import { createSimulationStateWithNonceAndBaseFeeFixing, getCurrentSimulationInput, visualizeSimulatorState } from './simulationUpdating.js'
import { getInterceptorTransactionStack, getTabState } from './storageVariables.js'

let confirmTransactionAbortController = new AbortController()
export const getConfirmTransactionAbortController = () => confirmTransactionAbortController

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
	}
	sendPopupMessageToOpenWindows({ method: 'popup_confirm_transaction_simulation_started' }, 'confirmTransaction')
	confirmTransactionAbortController.abort(NEW_BLOCK_ABORT)
	confirmTransactionAbortController = new AbortController()
	const thisConfirmTransactionAbortController = confirmTransactionAbortController
	const simulationStartedTimestamp = new Date()
	const transactionCreationError = transactionToSimulate.success ? undefined : transactionToSimulate.error
	// The insufficient balance override replaces the decoded reason, so its revert data is never decoded.
	const transactionCreationErrorDataToDecode = transactionCreationError?.insufficientBalanceMessage === undefined ? transactionCreationError?.data : undefined
	// The errors decoded in this function (the transaction creation error, plus the thrown simulation error in the catch path) use the recipient's ABI, a best-effort guess for a simulation error that may come from another stacked transaction, so they share a single lookup that is skipped unless one is a custom error selector.
	const getRecipientErrorAbis = async (errorDataToDecode: readonly (string | undefined)[]): Promise<readonly string[]> => {
		const params = transactionToSimulate.originalRequestParameters.params[0]
		if (!('to' in params)) return []
		if (params.to === undefined || params.to === null) return []
		const recipient = params.to
		return await getErrorDecodingAbis(errorDataToDecode, async () => await identifyAddress(ethereum, thisConfirmTransactionAbortController, recipient))
	}
	// The lookup runs after the simulation error was caught, so a new block arriving mid-lookup abandons the refresh like the abort guard at the top of that catch.
	const getRecipientErrorAbisUnlessNewBlockAborted = async (errorDataToDecode: readonly (string | undefined)[]) => {
		try {
			return await getRecipientErrorAbis(errorDataToDecode)
		} catch (lookupError: unknown) {
			if (isNewBlockAbort(lookupError)) return undefined
			throw lookupError
		}
	}
	// A transaction that failed to be created is not simulated, so callers pass the recipient ABI, plus the simulation ABIs when the simulation produced them, to decode its custom errors.
	const getTransactionCreationFailureReason = (errorAbis: readonly string[]) => {
		if (transactionCreationError === undefined) return undefined
		return transactionCreationError.insufficientBalanceMessage ?? getFailureReasonForDisplay(errorAbis, transactionCreationError, appendProtocolRevertReasonHints)
	}
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
		const transactionCreationFailureReason = getTransactionCreationFailureReason([...availableAbis, ...await getRecipientErrorAbis([transactionCreationErrorDataToDecode])])
		if (visualizedSimulatorState.visualizedSimulationState.success === false) {
			return { statusCode: 'failed', data: {
				...info,
				simulationStartedTimestamp,
				transactionCreationFailureReason,
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
				transactionToSimulate: transactionToSimulate.success
					? {
						...transactionToSimulate,
						transaction: {
							...transactionToSimulate.transaction,
							nonce: lastTransaction ? lastTransaction.transaction.nonce : transactionToSimulate.transaction.nonce,
						},
					}
					: transactionToSimulate,
				transactionCreationFailureReason,
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
		const recipientErrorAbis = await getRecipientErrorAbisUnlessNewBlockAborted([transactionCreationErrorDataToDecode, isJsonRpcResponseError ? baseError.data : undefined])
		if (recipientErrorAbis === undefined) return undefined
		return { statusCode: 'failed', data: {
			...info,
			simulationStartedTimestamp,
			transactionCreationFailureReason: getTransactionCreationFailureReason(recipientErrorAbis),
			error: { ...baseError, decodedErrorMessage: isJsonRpcResponseError ? getFailureReasonForDisplay(recipientErrorAbis, baseError, appendProtocolRevertReasonHints) : baseError.message },
			simulationState: {
				blockNumber: 0n,
				simulationConductedTimestamp: new Date()
			}
		} }
	}
}
