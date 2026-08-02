import type { SafeTransactionStack, SafeTransactionStacks } from '../types/safeTypes.js'
import type { InterceptorTransactionStack } from '../types/visualizer-types.js'
import { normalizeConsecutiveTimeManipulations } from '../utils/transactionStack.js'

export function reconcileSafeTransactionStack(stack: SafeTransactionStack, currentNonce: bigint) {
	const endNonce = stack.baseNonce + BigInt(stack.transactions.length)
	if (currentNonce < stack.baseNonce) {
		throw new Error(`The current Gnosis Safe nonce ${ currentNonce.toString() } precedes this stack's base nonce ${ stack.baseNonce.toString() }.`)
	}
	if (currentNonce > endNonce) {
		throw new Error(`The current Gnosis Safe nonce ${ currentNonce.toString() } is beyond this stack's final nonce ${ endNonce.toString() }.`)
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
