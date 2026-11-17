import type { InterceptorStackOperation } from '../types/visualizer-types.js'
import { modifyObject } from '../utils/typescript.js'

export type ImportedSimulationStackAdmission =
	| { readonly admitted: true, readonly operations: readonly InterceptorStackOperation[] }
	| { readonly admitted: false, readonly rejection: string }

// The extension never saw the frame that requested an imported message, so the request origin claimed by the export file is dropped; getSiweQuarantineReasons then flags an imported sign-in message as having no recorded origin instead of trusting the file. Messages already in the stack keep the origin recorded when they were requested.
const withoutImportedMessageRequestOrigins = (operations: readonly InterceptorStackOperation[]): readonly InterceptorStackOperation[] => operations.map((operation) => {
	if (operation.type !== 'Message') return operation
	const { requestOrigin: _unobservedRequestOrigin, ...signedMessageTransaction } = operation.signedMessageTransaction
	return modifyObject(operation, { signedMessageTransaction })
})

// Every imported-stack admission rule lives here. Signers and supported simulation options are scenario inputs, including hypothetical Safe approvals.
export function admitImportedSimulationStackOperations(operations: readonly InterceptorStackOperation[]): ImportedSimulationStackAdmission {
	// Gnosis Safe proposals carry signatures that must stay synchronized with the Safe stack, which only Import Gnosis Safe keeps.
	if (operations.some((operation) => operation.type === 'Transaction' && operation.preSimulationTransaction.safeTransaction !== undefined)) {
		return { admitted: false, rejection: 'Gnosis Safe transactions cannot be imported through simulation stack import. Use Import Gnosis Safe so Gnosis Safe proposals and signatures remain synchronized.' }
	}
	return { admitted: true, operations: withoutImportedMessageRequestOrigins(operations) }
}
