import { operationBelongsToActiveStackContext, SIMULATION_STACK_CONTEXT } from '../utils/activeStackContext.js'
import { getSimulationStackChainId, setSimulationStackChainId, updateInterceptorTransactionStack } from './storageVariables.js'

// Called under the network transition lock. Legacy installations adopt the current chain; changed chains discard simulation operations while preserving chain-keyed Safe stacks.
export async function reconcileSimulationStackChain(chainId: bigint) {
	const previousChainId = await getSimulationStackChainId()
	if (previousChainId === chainId) return
	if (previousChainId !== undefined) {
		await updateInterceptorTransactionStack((stack) => ({ operations: stack.operations.filter((operation) => !operationBelongsToActiveStackContext(operation, SIMULATION_STACK_CONTEXT)) }))
	}
	// Advance only after clearing succeeds. Restart recovery repeats harmless cleanup until both writes succeed, before admitting new simulation operations.
	await setSimulationStackChainId(chainId)
}
