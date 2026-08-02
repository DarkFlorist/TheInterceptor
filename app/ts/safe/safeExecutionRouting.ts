import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { getInputFieldFromDataOrInput } from '../simulation/services/SimulationModeEthereumClientService.js'
import type { SendTransactionParams } from '../types/JsonRpc-types.js'
import { isSafeEntryWithSafeSigner, type SafeEntry } from '../types/addressBookTypes.js'
import { areEqualUint8Arrays } from '../utils/typed-arrays.js'
import { getSafeContractState } from './safeCore.js'
import { completeSafeExecutionWithConfiguredSigner } from './safeExecution.js'

const SAFE_EXEC_TRANSACTION_SELECTOR = Uint8Array.from([0x6a, 0x76, 0x12, 0x02])

export function areSafeExecutionSignerRequestsEqual(first: SendTransactionParams, second: SendTransactionParams) {
	const firstTransaction = first.params[0]
	const secondTransaction = second.params[0]
	return firstTransaction.type === secondTransaction.type
		&& firstTransaction.from === secondTransaction.from
		&& firstTransaction.to === secondTransaction.to
		&& firstTransaction.gas === secondTransaction.gas
		&& firstTransaction.value === secondTransaction.value
		&& firstTransaction.gasPrice === secondTransaction.gasPrice
		&& firstTransaction.maxPriorityFeePerGas === secondTransaction.maxPriorityFeePerGas
		&& firstTransaction.maxFeePerGas === secondTransaction.maxFeePerGas
		&& areEqualUint8Arrays(firstTransaction.data, secondTransaction.data)
		&& areEqualUint8Arrays(firstTransaction.input, secondTransaction.input)
}

export function isSafeExecutionRequestForActiveSafe(transactionParams: SendTransactionParams, safeEntry: SafeEntry | undefined) {
	if (!isSafeEntryWithSafeSigner(safeEntry)) return false
	const transaction = transactionParams.params[0]
	if (transaction.from !== safeEntry.address || transaction.to !== safeEntry.address) return false
	const input = getInputFieldFromDataOrInput(transaction)
	return SAFE_EXEC_TRANSACTION_SELECTOR.every((byte, index) => input[index] === byte)
}

export function getSafeExecutionSignerRoute(transactionParams: SendTransactionParams, safeEntry: SafeEntry | undefined) {
	if (!isSafeEntryWithSafeSigner(safeEntry) || !isSafeExecutionRequestForActiveSafe(transactionParams, safeEntry)) return undefined
	return {
		executor: safeEntry.safeSignerAddress,
		transactionParams: {
			...transactionParams,
			params: [{
				...transactionParams.params[0],
				from: safeEntry.safeSignerAddress,
			}] as const,
		},
	}
}

export async function prepareSafeExecutionSignerRoute(
	ethereumClientService: EthereumClientService,
	transactionParams: SendTransactionParams,
	safeEntry: SafeEntry | undefined,
) {
	const route = getSafeExecutionSignerRoute(transactionParams, safeEntry)
	if (route === undefined || !isSafeEntryWithSafeSigner(safeEntry)) return undefined
	const transaction = route.transactionParams.params[0]
	if (transaction.value !== undefined && transaction.value !== 0n) {
		throw new Error('A direct Gnosis Safe execution transaction must have zero outer ETH value. The value transferred by the Gnosis Safe belongs inside execTransaction.')
	}
	const input = getInputFieldFromDataOrInput(transaction)
	const safeState = await getSafeContractState(ethereumClientService, safeEntry.address)
	if (safeEntry.safeVersion !== undefined && safeEntry.safeVersion !== safeState.version) {
		throw new Error(`The Gnosis Safe version is now ${ safeState.version }, but the address-book entry records ${ safeEntry.safeVersion }.`)
	}
	const completedInput = await completeSafeExecutionWithConfiguredSigner(
		ethereumClientService.getChainId(),
		safeEntry.address,
		safeEntry.safeSignerAddress,
		safeState,
		input,
	)
	return {
		...route,
		safeState,
		transactionParams: {
			...route.transactionParams,
			params: [{
				...transaction,
				...(transaction.data === undefined ? {} : { data: completedInput }),
				...(transaction.input === undefined ? {} : { input: completedInput }),
			}] as const,
		},
	}
}
