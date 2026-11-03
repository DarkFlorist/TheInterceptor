import { createSaltSearch, withUniqueSimulationHash } from '../simulation/services/simulationTransactionSigning.js'
import type { InterceptorTransactionStack, PreSimulationTransaction } from '../types/visualizer-types.js'
import { last } from '../utils/array.js'

// The stack normalization that keeps stacked transaction hashes unique: each transaction nextStack adds, one whose identifier previousStack lacks, gets a hash no other stacked transaction has, in stack order. Transactions previousStack held keep theirs, even duplicates stored before #1713, so such a stack still loads and updates.
export const withUniqueAddedTransactionHashes = (previousStack: InterceptorTransactionStack, nextStack: InterceptorTransactionStack): InterceptorTransactionStack => {
	const previousIdentifiers = new Set(previousStack.operations.flatMap((operation) => operation.type === 'Transaction' ? [operation.preSimulationTransaction.transactionIdentifier] : []))
	const takenHashes = new Set(nextStack.operations.flatMap((operation) => operation.type === 'Transaction' && previousIdentifiers.has(operation.preSimulationTransaction.transactionIdentifier) ? [operation.preSimulationTransaction.signedTransaction.hash] : []))
	const saltSearch = createSaltSearch()
	return { ...nextStack, operations: nextStack.operations.map((operation) => {
		if (operation.type !== 'Transaction' || previousIdentifiers.has(operation.preSimulationTransaction.transactionIdentifier)) return operation
		const preSimulationTransaction = withUniqueSimulationHash(operation.preSimulationTransaction, takenHashes, saltSearch)
		takenHashes.add(preSimulationTransaction.signedTransaction.hash)
		return preSimulationTransaction === operation.preSimulationTransaction ? operation : { ...operation, preSimulationTransaction }
	}) }
}

// The transaction as appending it to stack stores it, so a confirmation preview shows the hash accepting it stores.
export const asAppendedToStack = (stack: InterceptorTransactionStack, transaction: PreSimulationTransaction): PreSimulationTransaction => {
	const appended = last(withUniqueAddedTransactionHashes(stack, { operations: [...stack.operations, { type: 'Transaction', preSimulationTransaction: transaction }] }).operations)
	if (appended?.type !== 'Transaction') throw new Error('The appended transaction is missing from the stack')
	return appended.preSimulationTransaction
}
