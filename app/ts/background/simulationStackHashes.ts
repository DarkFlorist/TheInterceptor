import { createSaltSearch, withUniqueSimulationHash } from '../simulation/services/simulationTransactionSigning.js'
import type { InterceptorStackOperation, InterceptorTransactionStack, PreSimulationTransaction } from '../types/visualizer-types.js'

const getTransactionHashes = (operations: readonly InterceptorStackOperation[]) => operations.flatMap((operation) => operation.type === 'Transaction' ? [operation.preSimulationTransaction.signedTransaction.hash] : [])

// Appends operations to the stack, giving each appended transaction, in order, a hash no other stacked transaction has (withUniqueSimulationHash). The stacked transactions keep theirs, even duplicates a stack stored before #1713 holds. Returns the operations as appended, whose hashes are the stored ones.
export const appendOperationsToStack = (stack: InterceptorTransactionStack, operations: readonly InterceptorStackOperation[]) => {
	const takenHashes = new Set(getTransactionHashes(stack.operations))
	const saltSearch = createSaltSearch()
	const appended = operations.map((operation): InterceptorStackOperation => {
		if (operation.type !== 'Transaction') return operation
		const preSimulationTransaction = withUniqueSimulationHash(operation.preSimulationTransaction, takenHashes, saltSearch)
		takenHashes.add(preSimulationTransaction.signedTransaction.hash)
		return preSimulationTransaction === operation.preSimulationTransaction ? operation : { ...operation, preSimulationTransaction }
	})
	return { stack: { ...stack, operations: [...stack.operations, ...appended] }, appended }
}

// Appends one transaction to the stack and returns it as stacked, with the hash it is stored under.
export const appendTransactionToStack = (stack: InterceptorTransactionStack, transaction: PreSimulationTransaction) => {
	const { stack: updatedStack, appended: [appended] } = appendOperationsToStack(stack, [{ type: 'Transaction', preSimulationTransaction: transaction }])
	if (appended?.type !== 'Transaction') throw new Error('The appended transaction is missing from the stack')
	return { stack: updatedStack, transaction: appended.preSimulationTransaction }
}
