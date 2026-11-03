import { createSaltSearch, withUniqueSimulationHash } from '../simulation/services/simulationTransactionSigning.js'
import type { PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import type { InterceptorStackOperation, InterceptorTransactionStack, PreSimulationTransaction } from '../types/visualizer-types.js'

const getTransactionHashes = (operations: readonly InterceptorStackOperation[]) => operations.flatMap((operation) => operation.type === 'Transaction' ? [operation.preSimulationTransaction.signedTransaction.hash] : [])

// The hashes pending simulation-mode confirmations reserved when they were formed (reserveTransactionHash), which no other transaction may take before they are accepted or dropped.
export const getReservedTransactionHashes = (pending: readonly PendingTransactionOrSignableMessage[]): ReadonlySet<bigint> => new Set(pending.flatMap((request) => request.type === 'Transaction' && request.reservedTransactionHash !== undefined ? [request.reservedTransactionHash] : []))

// The hash a simulation-mode confirmation's transaction keeps from its forming on: its preview shows it and accepting stacks it, so the page gets the hash it was shown. It is free on the stack and among the other confirmations' reservations.
export const reserveTransactionHash = (stack: InterceptorTransactionStack, reservedHashes: ReadonlySet<bigint>, transaction: PreSimulationTransaction) => (
	withUniqueSimulationHash(transaction, new Set([...getTransactionHashes(stack.operations), ...reservedHashes])).signedTransaction.hash
)

// Appends operations to the stack, giving each appended transaction, in order, a hash that no stacked transaction has and no pending confirmation reserved (withUniqueSimulationHash). The stacked transactions keep theirs, even duplicates a stack stored before #1713 holds. Returns the operations as appended, whose hashes are the stored ones.
export const appendOperationsToStack = (stack: InterceptorTransactionStack, operations: readonly InterceptorStackOperation[], reservedHashes: ReadonlySet<bigint>) => {
	const takenHashes = new Set([...getTransactionHashes(stack.operations), ...reservedHashes])
	const saltSearch = createSaltSearch()
	const appended = operations.map((operation): InterceptorStackOperation => {
		if (operation.type !== 'Transaction') return operation
		const preSimulationTransaction = withUniqueSimulationHash(operation.preSimulationTransaction, takenHashes, saltSearch)
		takenHashes.add(preSimulationTransaction.signedTransaction.hash)
		return preSimulationTransaction === operation.preSimulationTransaction ? operation : { ...operation, preSimulationTransaction }
	})
	return { stack: { ...stack, operations: [...stack.operations, ...appended] }, appended }
}

// Appends an accepted confirmation's transaction under the hash it was previewed with, its reservation. Undefined if a stacked transaction already has that hash, which only an append that ignored the reservation, or a request pending from before reservations, can cause.
export const appendAcceptedTransactionToStack = (stack: InterceptorTransactionStack, transaction: PreSimulationTransaction): InterceptorTransactionStack | undefined => {
	if (getTransactionHashes(stack.operations).includes(transaction.signedTransaction.hash)) return undefined
	return { ...stack, operations: [...stack.operations, { type: 'Transaction', preSimulationTransaction: transaction }] }
}
