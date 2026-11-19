import { isAccountOnlyMethod } from './accountRequestMethods.js'

// Methods the Interceptor computes from the request alone, with no chain state; personal_ecRecover recovers a signer from its message and signature.
const LOCALLY_COMPUTED_METHODS = new Set<string>([
	'personal_ecRecover',
])

// Whether the Interceptor answers a method without its RPC: account-only methods and locally computed ones. Request routing keeps these local even on networks reachable only through the signer, and does not wake the Interceptor's RPC for them.
export function isAnsweredWithoutInterceptorRpc(method: string) {
	return isAccountOnlyMethod(method) || LOCALLY_COMPUTED_METHODS.has(method)
}
