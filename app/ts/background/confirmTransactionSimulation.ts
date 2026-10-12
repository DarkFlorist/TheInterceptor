import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { parseInputData } from '../simulation/parsing.js'
import { appendTransactionsToInput, getInputFieldFromDataOrInput } from '../simulation/services/SimulationModeEthereumClientService.js'
import { getSignedTransactionForSimulation } from '../simulation/services/simulationTransactionSigning.js'
import type { TokenPriceService } from '../simulation/services/priceEstimator.js'
import { createSafeExecutionPreSimulationTransaction, createSafeSigningSimulationInput } from '../safe/safeSimulation.js'
import type { ConfirmTransactionTransactionSingleVisualization, FailedTransactionPreview } from '../types/accessRequest.js'
import type { EnrichedEthereumInputData } from '../types/EnrichedEthereumData.js'
import type { AddressBookEntry } from '../types/addressBookTypes.js'
import type { SafeTransactionSigningRequest } from '../types/safeTypes.js'
import type { MaybeSimulatedTransaction, VisualizedSimulatorState, WebsiteCreatedEthereumTransactionOrFailed } from '../types/visualizer-types.js'
import { last } from '../utils/array.js'
import { NEW_BLOCK_ABORT, JSON_RPC_ERROR_CODE_INTERNAL_ERROR } from '../utils/constants.js'
import { decodeEthereumError } from '../utils/errorDecoding.js'
import { JsonRpcResponseError, reportUnexpectedError, isExpectedInfrastructureError, isFailedToFetchError, isNewBlockAbort } from '../utils/errors.js'
import { promiseAllMapAbortSafe, type UniqueRequestIdentifier } from '../utils/requests.js'
import { sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { getAddressesForSolidityTypes, getTransactionAddresses, identifyAddress } from './metadataUtils.js'
import { getSimulationErrorAbis } from './simulationErrorAbi.js'
import { createSimulationStateWithNonceAndBaseFeeFixing, getCurrentSimulationInput, visualizeSimulatorState } from './simulationUpdating.js'
import { getInterceptorTransactionStack, getTabState } from './storageVariables.js'

let confirmTransactionAbortController = new AbortController()
export const getConfirmTransactionAbortController = () => confirmTransactionAbortController

// The formed transaction when there is one, otherwise the website's request, which may lack the sender and cannot name the contract a creation would deploy.
const getFailedTransactionContents = (transactionToSimulate: WebsiteCreatedEthereumTransactionOrFailed) => {
	if (transactionToSimulate.success) return { call: transactionToSimulate.transaction, addresses: getTransactionAddresses(transactionToSimulate.transaction) }
	const request = transactionToSimulate.originalRequestParameters
	if (request.method !== 'eth_sendTransaction') return undefined
	const transaction = request.params[0]
	const requestedAddresses = [transaction.from, transaction.to, ...(transaction.authorizationList ?? []).map((authorization) => authorization.address)]
	return {
		call: { to: transaction.to, value: transaction.value ?? 0n, input: getInputFieldFromDataOrInput(transaction) },
		addresses: requestedAddresses.filter((address): address is bigint => address !== undefined && address !== null),
	}
}

type ResolvedTransactionMetadata = {
	readonly addressBookEntries: readonly AddressBookEntry[]
	readonly parsedInputData: EnrichedEthereumInputData | undefined
}

const NO_RESOLVED_METADATA: ResolvedTransactionMetadata = { addressBookEntries: [], parsedInputData: undefined }

/** Resolves the addresses and calldata of a transaction without simulation results through the same address-book and ABI pipeline as simulated transactions, reusing metadata the simulation already resolved. */
export async function getFailedTransactionPreview(
	ethereum: EthereumClientService,
	requestAbortController: AbortController | undefined,
	transactionToSimulate: WebsiteCreatedEthereumTransactionOrFailed,
	safeSigningRequest: SafeTransactionSigningRequest | undefined,
	resolvedMetadata = NO_RESOLVED_METADATA,
): Promise<FailedTransactionPreview> {
	const contents = getFailedTransactionContents(transactionToSimulate)
	const parsedInputData: EnrichedEthereumInputData = resolvedMetadata.parsedInputData ?? (contents === undefined
		? { type: 'NonParsed', input: new Uint8Array() }
		: await parseInputData(contents.call, ethereum, requestAbortController))
	const safeTx = safeSigningRequest?.safeTx
	const addresses = new Set([
		...contents?.addresses ?? [],
		...parsedInputData.type === 'Parsed' ? getAddressesForSolidityTypes(parsedInputData.args) : [],
		...safeTx === undefined ? [] : [safeTx.domain.verifyingContract, safeTx.message.to, safeTx.message.gasToken, safeTx.message.refundReceiver],
	])
	const addressBookEntries = await promiseAllMapAbortSafe(Array.from(addresses), async (address) => (
		resolvedMetadata.addressBookEntries.find((entry) => entry.address === address) ?? await identifyAddress(ethereum, requestAbortController, address)
	))
	return { addressBookEntries, parsedInputData }
}

// Without a Safe signing request the formed transaction is simulated as is, so the simulation's parse of its calldata is the one the failure view shows.
const getMetadataResolvedBySimulation = (
	visualizedSimulatorState: VisualizedSimulatorState,
	transactionToSimulate: WebsiteCreatedEthereumTransactionOrFailed,
	safeSigningRequest: SafeTransactionSigningRequest | undefined,
): ResolvedTransactionMetadata => {
	const visualizedTransaction = safeSigningRequest === undefined
		? visualizedSimulatorState.visualizedSimulationState.visualizedBlocks
			.flatMap((block): readonly MaybeSimulatedTransaction[] => block.simulatedAndVisualizedTransactions)
			.find((transaction) => transaction.transactionIdentifier === transactionToSimulate.transactionIdentifier)
		: undefined
	return { addressBookEntries: visualizedSimulatorState.addressBookEntries, parsedInputData: visualizedTransaction?.parsedInputData }
}

// Missing names or ABIs must not hide why the transaction failed, so the failure view is shown without a preview when the metadata lookup fails.
async function getFailedTransactionPreviewFields(
	ethereum: EthereumClientService,
	requestAbortController: AbortController,
	transactionToSimulate: WebsiteCreatedEthereumTransactionOrFailed,
	safeSigningRequest: SafeTransactionSigningRequest | undefined,
	resolvedMetadata = NO_RESOLVED_METADATA,
) {
	try {
		return { failedTransactionPreview: await getFailedTransactionPreview(ethereum, requestAbortController, transactionToSimulate, safeSigningRequest, resolvedMetadata) }
	} catch (error: unknown) {
		if (isExpectedInfrastructureError(error)) return {}
		await reportUnexpectedError(error, { code: 'failed_transaction_preview_failed' })
		return {}
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
						transactionIdentifier: transactionToSimulate.transactionIdentifier,
						...(transactionToSimulate.simulationOptions === undefined ? {} : { simulationOptions: transactionToSimulate.simulationOptions }),
					}
					: createSafeExecutionPreSimulationTransaction(transactionToSimulate, safeSigningRequest)
				: undefined
			const simulationStateWithNewTransaction = preSimulationTransaction === undefined
				? simulationInput
				: appendTransactionsToInput(simulationInput, [preSimulationTransaction], undefined, {}, preSimulationTransaction.simulationOptions?.simulateWithZeroBaseFee ?? false)
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
				...await getFailedTransactionPreviewFields(ethereum, thisConfirmTransactionAbortController, transactionToSimulate, safeSigningRequest, getMetadataResolvedBySimulation(visualizedSimulatorState, transactionToSimulate, safeSigningRequest)),
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
				...transactionToSimulate.success ? {} : await getFailedTransactionPreviewFields(ethereum, thisConfirmTransactionAbortController, transactionToSimulate, safeSigningRequest, { addressBookEntries: visualizedSimulatorState.addressBookEntries, parsedInputData: undefined }),
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
			...await getFailedTransactionPreviewFields(ethereum, thisConfirmTransactionAbortController, transactionToSimulate, safeSigningRequest),
			simulationStartedTimestamp,
			error: { ...baseError, decodedErrorMessage: isJsonRpcResponseError ? decodeEthereumError(await extractToAbi(), baseError).reason : baseError.message },
			simulationState: {
				blockNumber: 0n,
				simulationConductedTimestamp: new Date()
			}
		} }
	}
}
