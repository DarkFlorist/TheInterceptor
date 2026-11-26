import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { getGnosisSafeContractState, type GnosisSafeContractState } from '../gnosisSafe/gnosisSafeCore.js'
import { reconcileGnosisSafeTransactionState } from '../gnosisSafe/gnosisSafeStack.js'
import type { GnosisSafeTransactionStack } from '../types/gnosisSafeTypes.js'
import { updateTransactionState } from './storageVariables.js'

export type ReconciledStoredGnosisSafeState = {
	readonly safeState: GnosisSafeContractState
	readonly storedStack: GnosisSafeTransactionStack | undefined
}

export async function reconcileStoredGnosisSafeState(
	ethereum: EthereumClientService,
	safeAddress: bigint,
	knownSafeState?: GnosisSafeContractState,
): Promise<ReconciledStoredGnosisSafeState> {
	const safeState = knownSafeState ?? await getGnosisSafeContractState(ethereum, safeAddress)
	const chainId = ethereum.getChainId()
	const transactionState = await updateTransactionState((previousState) =>
		reconcileGnosisSafeTransactionState(previousState, chainId, safeAddress, safeState.nonce)
	)
	return {
		safeState,
		storedStack: transactionState.safeTransactionStacks.find((stack) =>
			stack.chainId === chainId && stack.safeAddress === safeAddress
		),
	}
}
