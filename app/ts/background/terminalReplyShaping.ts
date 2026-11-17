import * as funtypes from 'funtypes'
import type { PendingTransactionOrSignableMessage, ResolutionInput } from '../types/accessRequest.js'
import type { InterceptedRequestForward } from '../types/interceptor-messages.js'
import type { InterceptorStackOperation } from '../types/visualizer-types.js'
import { EthereumBytes32 } from '../types/wire-types.js'
import { simulatePersonalSign } from '../simulation/services/simulationPersonalSigning.js'
import { METAMASK_ERROR_BLANKET_ERROR, METAMASK_ERROR_USER_REJECTED_REQUEST } from '../utils/constants.js'
import { assertNever } from '../utils/typescript.js'
import { findStackOperation, getRequestStackIdentifier } from './simulationStackHashes.js'
import { getInterceptorTransactionStack } from './storageVariables.js'

export const formRejectMessage = (code: number, errorString: string) => ({ type: 'result' as const, error: { code, message: errorString } })

// The terminal reply that a result or error message gives a request.
export function toTerminalReply(request: PendingTransactionOrSignableMessage, message: { type: 'result', error: { code: number, message: string } } | { type: 'result', result: unknown }): InterceptedRequestForward {
	if ('error' in message) return { ...request.originalRequestParameters, ...message, uniqueRequestIdentifier: request.uniqueRequestIdentifier }
	if (request.originalRequestParameters.method === 'eth_sendRawTransaction' || request.originalRequestParameters.method === 'eth_sendTransaction') return { ...request.originalRequestParameters, ...message, result: EthereumBytes32.parse(message.result), uniqueRequestIdentifier: request.uniqueRequestIdentifier }
	return { ...request.originalRequestParameters, ...message, result: funtypes.String.parse(message.result), uniqueRequestIdentifier: request.uniqueRequestIdentifier }
}

// What a request can leave on the simulation stack.
type StackedRequestOperation = Extract<InterceptorStackOperation, { readonly type: 'Transaction' | 'Message' }>

// The one terminal reply of a request stacked on the simulation stack, whichever resolution commits it (an accept, or a decline of a request stacked before its reply was committed): a transaction's stacked hash, a message's simulated signature.
export async function toStackedTerminalReply(request: PendingTransactionOrSignableMessage, stacked: StackedRequestOperation) {
	switch (stacked.type) {
		case 'Transaction': return toTerminalReply(request, { type: 'result', result: EthereumBytes32.serialize(stacked.preSimulationTransaction.signedTransaction.hash) })
		case 'Message': return toTerminalReply(request, { type: 'result', result: (await simulatePersonalSign(stacked.signedMessageTransaction.originalRequestParameters, stacked.signedMessageTransaction.fakeSignedFor)).signature })
		default: return assertNever(stacked)
	}
}

// Answers a request that is declined: a rejection, unless it is already stacked in simulation mode (an accept stacked it and failed before its reply was committed, or its commitment and queued reply were lost), when it gets what accepting gives it: a transaction's stacked hash, a message's simulated signature. Its identifier is unique to it (createRequestIdentity), so what is found on the stack was stacked by this request, even when a page reused its request id.
export async function getDeclinedRequestReply(request: PendingTransactionOrSignableMessage, reason: Extract<ResolutionInput, { readonly kind: 'decline' }>['reason']) {
	const rejection = reason === 'reject' && request.transactionOrMessageCreationStatus !== 'Simulated'
		? formRejectMessage(METAMASK_ERROR_BLANKET_ERROR, 'The Interceptor failed to process the transaction')
		: formRejectMessage(METAMASK_ERROR_USER_REJECTED_REQUEST, 'User denied transaction signature')
	const stacked = request.simulationMode ? findStackOperation((await getInterceptorTransactionStack()).operations, getRequestStackIdentifier(request)) : undefined
	return stacked === undefined ? toTerminalReply(request, rejection) : await toStackedTerminalReply(request, stacked)
}
