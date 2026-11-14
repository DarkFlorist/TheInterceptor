import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { getSafeContractState, type SafeContractState } from '../safe/safeCore.js'
import { reconcileSafeTransactionState } from '../safe/safeStack.js'
import type { SafeTransactionStack } from '../types/safeTypes.js'
import { updateTransactionState } from './storageVariables.js'

export type ReconciledStoredSafeState = {
	readonly safeState: SafeContractState
	readonly storedStack: SafeTransactionStack | undefined
	// Whether reconciliation dropped operations the Safe has already executed from storage, so a stack read before it is out of date.
	readonly removedExecutedOperations: boolean
}

export async function reconcileStoredSafeState(
	ethereum: EthereumClientService,
	safeAddress: bigint,
	knownSafeState?: SafeContractState,
): Promise<ReconciledStoredSafeState> {
	const safeState = knownSafeState ?? await getSafeContractState(ethereum, safeAddress)
	const chainId = ethereum.getChainId()
	let removedExecutedOperations = false
	const transactionState = await updateTransactionState((previousState) => {
		const reconciledState = reconcileSafeTransactionState(previousState, chainId, safeAddress, safeState.nonce)
		// reconcileSafeTransactionState returns the state it was given when the Safe executed none of the stored operations.
		removedExecutedOperations = reconciledState !== previousState
		return reconciledState
	})
	return {
		safeState,
		removedExecutedOperations,
		storedStack: transactionState.safeTransactionStacks.find((stack) =>
			stack.chainId === chainId && stack.safeAddress === safeAddress
		),
	}
}
