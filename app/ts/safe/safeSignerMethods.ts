import { SAFE_APPS_REQUEST_METHOD, SAFE_EXECUTION_METHOD, SAFE_SIGNATURE_METHOD } from '../types/safeRpcMethods.js'
import type { SafePendingFlow } from './safePendingFlow.js'

// Only a validated Safe confirmation can authorize replacing a pending method; the private bridge transports this authorization as data.
export function getSafeSignerAuthorizedRequestMethods(flowKind: SafePendingFlow['kind'] | undefined, signerMethod: string): readonly string[] | undefined {
	if (flowKind === undefined) return undefined
	if (flowKind === 'directExecution') return signerMethod === SAFE_EXECUTION_METHOD ? [SAFE_APPS_REQUEST_METHOD] : undefined
	if (signerMethod !== SAFE_SIGNATURE_METHOD) return undefined
	return [SAFE_APPS_REQUEST_METHOD, flowKind === 'proposal' ? SAFE_EXECUTION_METHOD : 'personal_sign']
}
