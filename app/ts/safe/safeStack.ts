import type { SafeOwnerSignature, SafeTransactionStack, SafeTransactionStacks } from '../types/safeTypes.js'
import type { InterceptorTransactionStack } from '../types/visualizer-types.js'
import { normalizeConsecutiveTimeManipulations } from '../utils/transactionStack.js'
import { createSafeContractValidationFailure } from './safeCore.js'

export type ActiveStackContext =
	| { readonly simulationMode: true }
	| {
		readonly simulationMode: false
		readonly activeSafeAddress: bigint | undefined
		readonly chainId: bigint
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

export function mergeSafeOwnerSignatures(existing: readonly SafeOwnerSignature[], additions: readonly SafeOwnerSignature[]) {
	const merged = [...existing]
	for (const addition of additions) {
		if (!merged.some((signature) => signature.signer === addition.signer)) merged.push(addition)
	}
	return merged
}

export function reconcileSafeTransactionStack(stack: SafeTransactionStack, currentNonce: bigint) {
	const endNonce = stack.baseNonce + BigInt(stack.transactions.length)
	if (currentNonce < stack.baseNonce) {
		throw createSafeContractValidationFailure(`The current Gnosis Safe nonce ${ currentNonce.toString() } precedes this stack's base nonce ${ stack.baseNonce.toString() }.`)
	}
	if (currentNonce > endNonce) {
		throw createSafeContractValidationFailure(`The current Gnosis Safe nonce ${ currentNonce.toString() } is beyond this stack's final nonce ${ endNonce.toString() }.`)
	}
	const executedTransactionCount = Number(currentNonce - stack.baseNonce)
	if (executedTransactionCount === 0) return stack
	return {
		...stack,
		baseNonce: currentNonce,
		transactions: stack.transactions.slice(executedTransactionCount),
	}
}

export function reconcileSafeTransactionState(
	state: {
		readonly safeTransactionStacks: SafeTransactionStacks
		readonly interceptorTransactionStack: InterceptorTransactionStack
	},
	chainId: bigint,
	safeAddress: bigint,
	currentNonce: bigint,
) {
	const stack = state.safeTransactionStacks.find((candidate) => candidate.chainId === chainId && candidate.safeAddress === safeAddress)
	if (stack === undefined) return state
	const reconciledStack = reconcileSafeTransactionStack(stack, currentNonce)
	if (reconciledStack === stack) return state
	const remainingIdentifiers = new Set(reconciledStack.transactions.map(({ transactionIdentifier }) => transactionIdentifier))
	const reconciledSafeTransactionIdentifiers = new Set(stack.transactions.map(({ transactionIdentifier }) => transactionIdentifier))
	return {
		safeTransactionStacks: state.safeTransactionStacks
			.map((candidate) => candidate === stack ? reconciledStack : candidate)
			.filter((candidate) => candidate.transactions.length > 0),
		interceptorTransactionStack: {
			operations: normalizeConsecutiveTimeManipulations(state.interceptorTransactionStack.operations.filter((operation) => {
				if (operation.type !== 'Transaction') return true
				const transactionIdentifier = operation.preSimulationTransaction.transactionIdentifier
				return !reconciledSafeTransactionIdentifiers.has(transactionIdentifier) || remainingIdentifiers.has(transactionIdentifier)
			})),
		},
	}
}
