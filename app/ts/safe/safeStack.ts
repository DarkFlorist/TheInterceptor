import type { SafeOwnerSignature, SafeStackTransaction, SafeTransactionStack, SafeTransactionStacks } from '../types/safeTypes.js'
import type { InterceptorTransactionStack } from '../types/visualizer-types.js'
import { getOperationsForActiveStackContext, getSafeStackContext } from '../utils/activeStackContext.js'
import { getSafeTxHash } from '../utils/eip712.js'
import { normalizeConsecutiveTimeManipulations } from '../utils/transactionStack.js'
import { createSafeContractValidationFailure } from './safeCore.js'

export function mergeSafeOwnerSignatures(existing: readonly SafeOwnerSignature[], additions: readonly SafeOwnerSignature[]) {
	const merged = [...existing]
	for (const addition of additions) {
		if (!merged.some((signature) => signature.signer === addition.signer)) merged.push(addition)
	}
	return merged
}

export function getSafeTransactionStackInvariantViolation(stack: SafeTransactionStack) {
	for (const [index, transaction] of stack.transactions.entries()) {
		if (transaction.safeTx.domain.verifyingContract !== stack.safeAddress) return 'Gnosis Safe transaction verifying contract does not match the stack Gnosis Safe.'
		if (transaction.safeTx.domain.chainId !== stack.chainId) return 'Gnosis Safe transaction chain ID does not match the stack chain.'
		if (transaction.safeTx.message.nonce !== stack.baseNonce + BigInt(index)) return 'Gnosis Safe stack transaction nonces must be contiguous.'
		if (BigInt(getSafeTxHash(transaction.safeTx)) !== transaction.safeTxHash) return 'A Gnosis Safe transaction hash does not match its transaction data.'
	}
	return undefined
}

export function mapSafeTransactionMetadata(
	stack: InterceptorTransactionStack,
	update: (safeTransaction: SafeStackTransaction) => SafeStackTransaction,
): InterceptorTransactionStack {
	return {
		operations: stack.operations.map((operation) => {
			if (operation.type !== 'Transaction') return operation
			const safeTransaction = operation.preSimulationTransaction.safeTransaction
			if (safeTransaction === undefined) return operation
			const updatedSafeTransaction = update(safeTransaction)
			if (updatedSafeTransaction === safeTransaction) return operation
			return {
				...operation,
				preSimulationTransaction: { ...operation.preSimulationTransaction, safeTransaction: updatedSafeTransaction },
			}
		}),
	}
}

export function recoverSafeTransactionStackFromLocalOperations(
	importedStack: SafeTransactionStack,
	interceptorTransactionStack: InterceptorTransactionStack,
) {
	const localTransactions = getOperationsForActiveStackContext(
		interceptorTransactionStack,
		getSafeStackContext(importedStack.safeAddress, importedStack.chainId),
	).flatMap((operation) => {
		if (operation.type !== 'Transaction') return []
		const safeTransaction = operation.preSimulationTransaction.safeTransaction
		return safeTransaction === undefined ? [] : [safeTransaction]
	})
	const importedTransactionHashes = importedStack.transactions.map(({ safeTxHash }) => safeTxHash)
	const matchingStartIndex = localTransactions.findIndex((_transaction, startIndex) =>
		importedTransactionHashes.every((safeTxHash, offset) => localTransactions[startIndex + offset]?.safeTxHash === safeTxHash)
	)
	if (matchingStartIndex === -1) return undefined
	const recoveredStack = { ...importedStack, transactions: localTransactions.slice(matchingStartIndex) }
	return getSafeTransactionStackInvariantViolation(recoveredStack) === undefined ? recoveredStack : undefined
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

type SafeTransactionState = {
	readonly safeTransactionStacks: SafeTransactionStacks
	readonly interceptorTransactionStack: InterceptorTransactionStack
}

export type ReconciledSafeTransactionState = {
	readonly state: SafeTransactionState
	// True only when the on-chain nonce proves a stored prefix executed. Callers must not infer this from object allocation or reference equality.
	readonly removedExecutedOperations: boolean
}

// Reconcile both stored representations and report the domain change explicitly. Unchanged results need not preserve reference identity.
export function reconcileSafeTransactionState(
	state: SafeTransactionState,
	chainId: bigint,
	safeAddress: bigint,
	currentNonce: bigint,
): ReconciledSafeTransactionState {
	const stack = state.safeTransactionStacks.find((candidate) => candidate.chainId === chainId && candidate.safeAddress === safeAddress)
	if (stack === undefined) return { state, removedExecutedOperations: false }
	const reconciledStack = reconcileSafeTransactionStack(stack, currentNonce)
	if (currentNonce === stack.baseNonce) return { state, removedExecutedOperations: false }
	const remainingIdentifiers = new Set(reconciledStack.transactions.map(({ transactionIdentifier }) => transactionIdentifier))
	const reconciledSafeTransactionIdentifiers = new Set(stack.transactions.map(({ transactionIdentifier }) => transactionIdentifier))
	return {
		removedExecutedOperations: true,
		state: {
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
		},
	}
}
