import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { appendTransactionsToInput } from '../simulation/services/SimulationModeEthereumClientService.js'
import type { TokenPriceService } from '../simulation/services/priceEstimator.js'
import { createSafeExecutionPreSimulationTransaction, createSafeSigningSimulationInput } from '../safe/safeSimulation.js'
import type { ConfirmTransactionTransactionSingleVisualization } from '../types/accessRequest.js'
import type { SafeTransactionSigningRequest } from '../types/safeTypes.js'
import type { WebsiteCreatedEthereumTransactionOrFailed } from '../types/visualizer-types.js'
import { last } from '../utils/array.js'
import { decodeEthereumError } from '../utils/errorDecoding.js'
import { getCurrentSimulationInput } from './simulationUpdating.js'
import { getInterceptorTransactionStack } from './storageVariables.js'
import { type ConfirmationRun, simulateConfirmationRun, toPreSimulationTransaction } from './confirmationSimulationRun.js'

// The simulation input of a single transaction's confirmation: the current simulation, or a Gnosis Safe signing request's own input, with the prepared transaction appended.
async function getSingleTransactionSimulationInput(transactionToSimulate: WebsiteCreatedEthereumTransactionOrFailed, safeSigningRequest: SafeTransactionSigningRequest | undefined) {
	const simulationInput = safeSigningRequest === undefined
		? await getCurrentSimulationInput()
		: createSafeSigningSimulationInput(await getInterceptorTransactionStack(), safeSigningRequest)
	if (!transactionToSimulate.success) return simulationInput
	const preSimulationTransaction = safeSigningRequest === undefined
		? toPreSimulationTransaction(transactionToSimulate)
		: createSafeExecutionPreSimulationTransaction(transactionToSimulate, safeSigningRequest)
	return appendTransactionsToInput(simulationInput, [preSimulationTransaction], undefined, {}, safeSigningRequest !== undefined)
}

// Runs the shared confirmation simulation protocol for one transaction and adds the transaction to its record: with the nonce it was simulated with, or with its preparation error decoded by the ABIs the simulation identified.
export async function refreshConfirmTransactionSimulation(
	ethereum: EthereumClientService,
	tokenPriceService: TokenPriceService,
	activeAddress: bigint,
	simulationMode: boolean,
	confirmationRun: ConfirmationRun,
	transactionToSimulate: WebsiteCreatedEthereumTransactionOrFailed,
	safeSigningRequest?: SafeTransactionSigningRequest,
): Promise<ConfirmTransactionTransactionSingleVisualization | undefined> {
	const requestParams = transactionToSimulate.originalRequestParameters.params[0]
	const record = await simulateConfirmationRun({
		ethereum,
		tokenPriceService,
		confirmationRun,
		activeAddress,
		simulationMode,
		getSimulationInput: async () => await getSingleTransactionSimulationInput(transactionToSimulate, safeSigningRequest),
		calledContracts: 'to' in requestParams && requestParams.to !== undefined && requestParams.to !== null ? [requestParams.to] : [],
	})
	if (record === undefined) return undefined
	if (record.statusCode === 'failed') return { statusCode: 'failed', data: { ...record.data, transactionToSimulate } }
	const lastTransaction = last(last(record.data.visualizedSimulationState.success ? record.data.visualizedSimulationState.visualizedBlocks : [])?.simulatedAndVisualizedTransactions ?? [])
	const availableAbis = record.data.addressBookEntries
		.map((entry) => 'abi' in entry && entry.abi !== undefined ? entry.abi : undefined)
		.filter((abiOrUndefined): abiOrUndefined is string => abiOrUndefined !== undefined)
	return {
		statusCode: 'success',
		data: {
			...record.data,
			transactionToSimulate: {
				...transactionToSimulate,
				...transactionToSimulate.success
					? { transaction: { ...transactionToSimulate.transaction, nonce: lastTransaction ? lastTransaction.transaction.nonce : transactionToSimulate.transaction.nonce } }
					: { error: { ...transactionToSimulate.error, decodedErrorMessage: decodeEthereumError(availableAbis, transactionToSimulate.error).reason } },
			},
		},
	}
}
