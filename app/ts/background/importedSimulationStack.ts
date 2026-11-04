import type { ExportedInterceptorStackOperation, InterceptorStackOperation } from '../types/visualizer-types.js'
import { assertNever, modifyObject } from '../utils/typescript.js'

export type ImportedSimulationStackAdmission =
	| { readonly admitted: true, readonly operations: readonly InterceptorStackOperation[] }
	| { readonly admitted: false, readonly rejection: string }

// This extension never saw how an imported operation was requested, so nothing an export file claims about that is trusted. Applied to the operations of an export file only; operations already in the stack keep what this extension recorded for them.
const toImportedStackOperation = (operation: ExportedInterceptorStackOperation): InterceptorStackOperation => {
	switch (operation.type) {
		// A message's active address and simulation signer cannot be re-derived from the message (for a Safe, an owner rather than the Safe signs), so they are kept for the simulation but the message is marked `importedFromExport`, and flagImportedSignature (importedStackTrust.ts) then flags it instead of trusting its account check. Its `safeMessageReview` stays, because a Safe message is only shown with its review when the review text hashes to the digest it signs.
		case 'Message': return { type: 'Message', signedMessageTransaction: { ...operation.signedMessageTransaction, importedFromExport: true } }
		// Every claimed simulation option is dropped, which leaves an imported transaction an ordinary one:
		// - Dropping `executeThroughSafe` is what guarantees a file can never make Interceptor assume a Gnosis Safe's owners approved a transaction; only a confirmation decides that (isSimulationModeSafeExecution). A simulation-mode Gnosis Safe stack therefore re-imports as ordinary transactions from the Safe, keeping their recorded hashes like any re-imported transaction (shared-hash cases are tracked in #1713). The whole object goes rather than the field alone, so no imported value of it, whatever authorizesExecutedCall would make of it, survives.
		// - A claimed `requiredChainId` decides on which chain the transaction is simulated at all.
		// - A claimed zero base fee lets a contract detect the simulation (`block.basefee == 0`) and behave differently in it.
		case 'Transaction': {
			const { simulationOptions: _claimedSimulationOptions, ...preSimulationTransaction } = operation.preSimulationTransaction
			return modifyObject(operation, { preSimulationTransaction })
		}
		case 'TimeManipulation': return operation
		default: return assertNever(operation)
	}
}

// Every rule deciding which operations of an imported simulation stack may enter the simulation stack, and in what form.
export function admitImportedSimulationStackOperations(operations: readonly ExportedInterceptorStackOperation[]): ImportedSimulationStackAdmission {
	// Gnosis Safe proposals carry signatures that must stay synchronized with the Safe stack, which only Import Gnosis Safe keeps.
	if (operations.some((operation) => operation.type === 'Transaction' && operation.preSimulationTransaction.safeTransaction !== undefined)) {
		return { admitted: false, rejection: 'Gnosis Safe transactions cannot be imported through simulation stack import. Use Import Gnosis Safe so Gnosis Safe proposals and signatures remain synchronized.' }
	}
	return { admitted: true, operations: operations.map(toImportedStackOperation) }
}
