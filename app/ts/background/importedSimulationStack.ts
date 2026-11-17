import type { InterceptorStackOperation } from '../types/visualizer-types.js'
import { modifyObject } from '../utils/typescript.js'

export type ImportedSimulationStackAdmission =
	| { readonly admitted: true, readonly operations: readonly InterceptorStackOperation[] }
	| { readonly admitted: false, readonly rejection: string }

// Running a transaction through a Gnosis Safe assumes the Safe's owners approved it, which only a confirmation decides (isSimulationModeSafeExecution), so every imported transaction's executeThroughSafe is dropped: a file can never make Interceptor assume an owner approval. A simulation-mode Gnosis Safe stack therefore re-imports as ordinary transactions from the Safe, keeping their recorded hashes like any re-imported transaction (shared-hash cases are tracked in #1713).
const withoutImportedGnosisSafeExecutions = (operations: readonly InterceptorStackOperation[]): readonly InterceptorStackOperation[] => operations.map((operation) => {
	if (operation.type !== 'Transaction') return operation
	const transaction = operation.preSimulationTransaction
	// Works on the executeThroughSafe field itself rather than authorizesExecutedCall: it removes the field, so no imported value of it, whatever authorizesExecutedCall makes of it, survives.
	if (transaction.simulationOptions?.executeThroughSafe === undefined) return operation
	const { executeThroughSafe: _importedExecuteThroughSafe, ...ordinarySimulationOptions } = transaction.simulationOptions
	return modifyObject(operation, { preSimulationTransaction: modifyObject(transaction, { simulationOptions: ordinarySimulationOptions }) })
})

// The extension never saw the frame that requested an imported message, so the request origin claimed by the export file is dropped; getSiweQuarantineReasons then flags an imported sign-in message as having no recorded origin instead of trusting the file. Messages already in the stack keep the origin recorded when they were requested.
const withoutImportedMessageRequestOrigins = (operations: readonly InterceptorStackOperation[]): readonly InterceptorStackOperation[] => operations.map((operation) => {
	if (operation.type !== 'Message') return operation
	const { requestOrigin: _unobservedRequestOrigin, ...signedMessageTransaction } = operation.signedMessageTransaction
	return modifyObject(operation, { signedMessageTransaction })
})

// Every rule deciding which operations of an imported simulation stack may enter the simulation stack, and in what form.
export function admitImportedSimulationStackOperations(operations: readonly InterceptorStackOperation[]): ImportedSimulationStackAdmission {
	// Gnosis Safe proposals carry signatures that must stay synchronized with the Safe stack, which only Import Gnosis Safe keeps.
	if (operations.some((operation) => operation.type === 'Transaction' && operation.preSimulationTransaction.safeTransaction !== undefined)) {
		return { admitted: false, rejection: 'Gnosis Safe transactions cannot be imported through simulation stack import. Use Import Gnosis Safe so Gnosis Safe proposals and signatures remain synchronized.' }
	}
	return { admitted: true, operations: withoutImportedMessageRequestOrigins(withoutImportedGnosisSafeExecutions(operations)) }
}
