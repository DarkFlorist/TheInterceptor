import type { ConfirmationRequest } from '../types/confirmationRequest.js'
import * as funtypes from 'funtypes'
import type { InterceptedRequest } from '../utils/requests.js'
import { SafeReviewInput } from '../types/safeReview.js'
import { serialize } from '../types/wire-types.js'
import { SendTransactionParams } from '../types/JsonRpc-types.js'
import { SignTypedDataParams } from '../types/jsonRpc-signing-types.js'
import { createSafeContractValidationFailure } from './safeCore.js'

const ExecutionEnvelope = funtypes.ReadonlyObject({ method: funtypes.Literal('execute'), params: funtypes.Unknown })
const ExecutionPayload = funtypes.Union(SendTransactionParams, SignTypedDataParams.And(funtypes.ReadonlyObject({ method: funtypes.Literal('eth_signTypedData_v4') })))
	.And(funtypes.ReadonlyObject({ safeRequestContext: SafeReviewInput }))

export function getSafeAppsExecution(request: InterceptedRequest) {
	if (request.method !== 'safe_apps_request' || !('params' in request)) return undefined
	const envelope = ExecutionEnvelope.safeParse(request.params?.[0])
	if (!envelope.success) return undefined
	const execution = ExecutionPayload.safeParse(envelope.value.params)
	if (!execution.success) throw createSafeContractValidationFailure('Invalid Safe Apps execution payload.')
	const { method, params } = serialize(ExecutionPayload, execution.value)
	// Normalize frontend admission data into the same operation model used by ordinary confirmations.
	const input = execution.value
	const confirmation: ConfirmationRequest = input.method === 'eth_sendTransaction'
		? { kind: 'transaction', parameters: { method: input.method, params: input.params }, safeTransaction: { operation: input.safeRequestContext.operation ?? 0, ...(input.safeRequestContext.message === undefined ? {} : { messageReview: input.safeRequestContext.message }) } }
		: { kind: 'message', parameters: { method: input.method, params: input.params }, ...(input.safeRequestContext.message === undefined ? {} : { review: input.safeRequestContext.message }) }
	return { request: { ...request, method, params }, confirmation }
}
