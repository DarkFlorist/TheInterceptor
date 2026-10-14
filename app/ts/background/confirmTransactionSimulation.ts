import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { appendTransactionsToInput } from '../simulation/services/SimulationModeEthereumClientService.js'
import { getSignedTransactionForSimulation } from '../simulation/services/simulationTransactionSigning.js'
import type { TokenPriceService } from '../simulation/services/priceEstimator.js'
import { createSafeExecutionPreSimulationTransaction, createSafeSigningSimulationInput } from '../safe/safeSimulation.js'
import type { ConfirmTransactionTransactionSingleVisualization, PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import type { SafeTransactionSigningRequest } from '../types/safeTypes.js'
import type { SimulationState, WebsiteCreatedEthereumTransactionOrFailed } from '../types/visualizer-types.js'
import { last } from '../utils/array.js'
import { NEW_BLOCK_ABORT, JSON_RPC_ERROR_CODE_INTERNAL_ERROR } from '../utils/constants.js'
import { decodeEthereumError } from '../utils/errorDecoding.js'
import { JsonRpcResponseError, reportUnexpectedError, isFailedToFetchError, isNewBlockAbort } from '../utils/errors.js'
import { doesUniqueRequestIdentifiersMatch, type UniqueRequestIdentifier } from '../utils/requests.js'
import { Semaphore } from '../utils/semaphore.js'
import { modifyObject } from '../utils/typescript.js'
import { sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { identifyAddress } from './metadataUtils.js'
import { getSimulationErrorAbis } from './simulationErrorAbi.js'
import { createSimulationStateWithNonceAndBaseFeeFixing, getCurrentSimulationInput, isSameSimulationRun, revisualizeSimulationMetadata, visualizeSimulatorState } from './simulationUpdating.js'
import { getInterceptorTransactionStack, getPendingTransactionsAndMessages, getTabState, updatePendingTransactionOrMessage } from './storageVariables.js'

let confirmTransactionAbortController = new AbortController()
export const getConfirmTransactionAbortController = () => confirmTransactionAbortController

let latestConfirmationSimulationId = 0
// Every confirmation simulation run gets a new id (see isSameSimulationRun). As in bumpPopupRefreshGeneration, the id is the millisecond clock bumped past the previous id, so ids increase within a background session and ids stored before a background restart are not handed out again unless the system clock went backwards.
function getNextConfirmationSimulationId() {
	latestConfirmationSimulationId = Math.max(latestConfirmationSimulationId + 1, Date.now())
	return latestConfirmationSimulationId
}

// Counts requested confirmation re-labels, one per address-book change (see relabelDisplayedConfirmationSimulation).
let confirmationRelabelRequests = 0

// The confirmation re-label in progress; only a new simulation of the same request cancels it.
let runningConfirmationRelabel: { readonly uniqueRequestIdentifier: UniqueRequestIdentifier, readonly abortController: AbortController } | undefined

// A run whose name lookups overlap a re-label request may have read the old address book, and that re-label cannot see the run before it is stored, so the run labels itself again.
async function visualizeConfirmationWithLatestAddressBook(simulationState: SimulationState, ethereum: EthereumClientService, tokenPriceService: TokenPriceService, abortController: AbortController) {
	let relabelRequestsBeforeLookups: number
	let visualizedSimulatorState: Awaited<ReturnType<typeof visualizeSimulatorState>>
	do {
		relabelRequestsBeforeLookups = confirmationRelabelRequests
		visualizedSimulatorState = await visualizeSimulatorState(simulationState, ethereum, tokenPriceService, abortController)
	} while (relabelRequestsBeforeLookups !== confirmationRelabelRequests)
	return visualizedSimulatorState
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
	if (runningConfirmationRelabel !== undefined && doesUniqueRequestIdentifiersMatch(runningConfirmationRelabel.uniqueRequestIdentifier, uniqueRequestIdentifier)) runningConfirmationRelabel.abortController.abort(NEW_BLOCK_ABORT)
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
			return await visualizeConfirmationWithLatestAddressBook(updatedSimulationState, ethereum, tokenPriceService, thisConfirmTransactionAbortController)
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

// Only a successful simulation of the displayed transaction, made on the services' chain by a version that identifies its runs, can be re-labelled; failed or still pending simulations show no names to re-label.
function getConfirmationVisualisationToRelabel(pending: PendingTransactionOrSignableMessage | undefined, chainId: bigint) {
	if (pending?.type !== 'Transaction' || pending.transactionOrMessageCreationStatus !== 'Simulated' || pending.popupVisualisation.statusCode !== 'success') return undefined
	const visualisation = pending.popupVisualisation
	if (visualisation.data.simulationId === undefined || visualisation.data.simulationState.rpcNetwork.chainId !== chainId) return undefined
	return visualisation
}

// One re-label at a time, so the last one requested reads the latest address book.
const confirmationRelabelSemaphore = new Semaphore(1)

// Re-labels the stored run of the confirmation the dialog displays without simulating; see "Address-book re-labels" in docs/popup-simulation-refresh.md for its ordering, cancellation and known limitation.
export async function relabelDisplayedConfirmationSimulation(ethereum: EthereumClientService, tokenPriceService: TokenPriceService) {
	confirmationRelabelRequests += 1
	await confirmationRelabelSemaphore.execute(async () => {
		const [displayed] = await getPendingTransactionsAndMessages()
		const visualisationToRelabel = getConfirmationVisualisationToRelabel(displayed, ethereum.getChainId())
		if (displayed === undefined || visualisationToRelabel === undefined) return
		const relabel = { uniqueRequestIdentifier: displayed.uniqueRequestIdentifier, abortController: new AbortController() }
		runningConfirmationRelabel = relabel
		try {
			const simulationMetadata = await revisualizeSimulationMetadata(visualisationToRelabel.data.simulationState, ethereum, tokenPriceService, relabel.abortController)
			// Lookups that made no further RPC request do not notice an abort; the newer run of this request labels itself instead.
			if (relabel.abortController.signal.aborted) return
			await updatePendingTransactionOrMessage(displayed.uniqueRequestIdentifier, async (current) => {
				if (current.type !== 'Transaction' || current.transactionOrMessageCreationStatus !== 'Simulated' || current.popupVisualisation.statusCode !== 'success') return undefined
				if (!isSameSimulationRun(current.popupVisualisation.data, visualisationToRelabel.data)) return undefined
				return modifyObject(current, { popupVisualisation: { statusCode: 'success', data: modifyObject(current.popupVisualisation.data, simulationMetadata) } })
			})
		} finally {
			runningConfirmationRelabel = undefined
		}
	})
}
