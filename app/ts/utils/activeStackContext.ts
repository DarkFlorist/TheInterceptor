import type { Settings } from '../types/interceptor-messages.js'
import type { InterceptorTransactionStack } from '../types/visualizer-types.js'

export type ActiveStackContext =
	| { readonly simulationMode: true }
	| {
		readonly simulationMode: false
		readonly activeSafeAddress: bigint | undefined
		readonly chainId: bigint
	}

export const SIMULATION_STACK_CONTEXT = { simulationMode: true } as const satisfies ActiveStackContext

export function getSafeStackContext(activeSafeAddress: bigint | undefined, chainId: bigint): ActiveStackContext {
	return { simulationMode: false, activeSafeAddress, chainId }
}

export function getActiveStackContext(settings: Pick<Settings, 'simulationMode' | 'activeSigningSafeAddress' | 'activeRpcNetwork'>): ActiveStackContext {
	return settings.simulationMode
		? SIMULATION_STACK_CONTEXT
		: getSafeStackContext(settings.activeSigningSafeAddress, settings.activeRpcNetwork.chainId)
}

export function activeStackContextsEqual(first: ActiveStackContext, second: ActiveStackContext) {
	if (first.simulationMode || second.simulationMode) return first.simulationMode === second.simulationMode
	return first.activeSafeAddress === second.activeSafeAddress && first.chainId === second.chainId
}

export function operationBelongsToActiveStackContext(
	operation: InterceptorTransactionStack['operations'][number],
	context: ActiveStackContext,
) {
	if (context.simulationMode) {
		return operation.type !== 'Transaction' || operation.preSimulationTransaction.safeTransaction === undefined
	}
	if (operation.type !== 'Transaction' || context.activeSafeAddress === undefined) return false
	const transaction = operation.preSimulationTransaction
	return transaction.safeTransaction?.safeTx.domain.verifyingContract === context.activeSafeAddress
		&& transaction.simulationOptions?.requiredChainId === context.chainId
}

export function getOperationsForActiveStackContext(stack: InterceptorTransactionStack, context: ActiveStackContext) {
	return stack.operations.filter((operation) => operationBelongsToActiveStackContext(operation, context))
}
