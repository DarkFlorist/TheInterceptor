import * as funtypes from 'funtypes'
import type { InterceptedRequest } from '../utils/requests.js'
import { SafeRequestContext } from '../types/safeRequestContext.js'
import { SendTransactionParams } from '../types/JsonRpc-types.js'
import { SignTypedDataParams } from '../types/jsonRpc-signing-types.js'
import { createSafeContractValidationFailure } from './safeCore.js'

const ExecutionEnvelope = funtypes.ReadonlyObject({ method: funtypes.Literal('execute'), params: funtypes.Unknown })
const ExecutionPayload = funtypes.Union(SendTransactionParams, SignTypedDataParams.And(funtypes.ReadonlyObject({ method: funtypes.Literal('eth_signTypedData_v4') })))
	.And(funtypes.ReadonlyObject({ safeRequestContext: SafeRequestContext }))

export function getSafeAppsExecution(request: InterceptedRequest) {
	if (request.method !== 'safe_apps_request' || !('params' in request)) return undefined
	const envelope = ExecutionEnvelope.safeParse(request.params?.[0])
	if (!envelope.success) return undefined
	const execution = ExecutionPayload.safeParse(envelope.value.params)
	if (!execution.success) throw createSafeContractValidationFailure('Invalid Safe Apps execution payload.')
	return execution.value
}

// Only the Safe Apps method owns this context; the generic provider transport carries ordinary method/params unchanged.
export function getSafeRequestContext(request: InterceptedRequest) {
	if (request.method !== 'safe_apps_request' || !('params' in request)) return undefined
	const envelope = ExecutionEnvelope.safeParse(request.params?.[0])
	if (!envelope.success) return undefined
	const context = funtypes.ReadonlyObject({ safeRequestContext: SafeRequestContext }).safeParse(envelope.value.params)
	return context.success ? context.value.safeRequestContext : undefined
}
