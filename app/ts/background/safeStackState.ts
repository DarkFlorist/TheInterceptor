import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { getSafeContractState, type SafeContractState } from '../safe/safeCore.js'
import { reconcileSafeTransactionState } from '../safe/safeStack.js'
import type { SafeTransactionStack } from '../types/safeTypes.js'
import { updateTransactionState } from './storageVariables.js'

export type ReconciledStoredSafeState = {
	readonly safeState: SafeContractState
	readonly storedStack: SafeTransactionStack | undefined
}

export async function reconcileStoredSafeState(
	ethereum: EthereumClientService,
	safeAddress: bigint,
	knownSafeState?: SafeContractState,
): Promise<ReconciledStoredSafeState> {
	const safeState = knownSafeState ?? await getSafeContractState(ethereum, safeAddress)
	const chainId = ethereum.getChainId()
	const transactionState = await updateTransactionState((previousState) =>
		reconcileSafeTransactionState(previousState, chainId, safeAddress, safeState.nonce)
	)
	return {
		safeState,
		storedStack: transactionState.safeTransactionStacks.find((stack) =>
			stack.chainId === chainId && stack.safeAddress === safeAddress
		),
	}
}
