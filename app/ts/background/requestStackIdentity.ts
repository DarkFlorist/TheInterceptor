import type { PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import type { TransactionOrMessageIdentifier } from '../types/interceptor-messages.js'
import type { InterceptorStackOperation } from '../types/visualizer-types.js'
import { assertNever } from '../utils/typescript.js'

// The one place that knows which stack operation belongs to which request or identifier. Identifiers are unique to a request (createRequestIdentity), so a match proves the request stacked the operation.
export const isStackOperationOf = (operation: InterceptorStackOperation, identifier: TransactionOrMessageIdentifier) => {
	switch (operation.type) {
		case 'Transaction': return identifier.type === 'Transaction' && identifier.transactionIdentifier === operation.preSimulationTransaction.transactionIdentifier
		case 'Message': return identifier.type === 'Message' && identifier.messageIdentifier === operation.signedMessageTransaction.messageIdentifier
		case 'TimeManipulation': return false
		default: return assertNever(operation)
	}
}
export const findStackOperation = <Identifier extends TransactionOrMessageIdentifier>(operations: readonly InterceptorStackOperation[], identifier: Identifier) => operations.find((operation): operation is Extract<InterceptorStackOperation, { readonly type: Identifier['type'] }> => isStackOperationOf(operation, identifier))
// The identifier that the request's operation on the stack carries.
export function getRequestStackIdentifier(request: PendingTransactionOrSignableMessage): TransactionOrMessageIdentifier {
	switch (request.type) {
		case 'Transaction': return { type: 'Transaction', transactionIdentifier: request.transactionIdentifier }
		case 'SignableMessage': return { type: 'Message', messageIdentifier: request.signedMessageTransaction.messageIdentifier }
		default: return assertNever(request)
	}
}

