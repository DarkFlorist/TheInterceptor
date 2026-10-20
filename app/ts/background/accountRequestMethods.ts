const ACCOUNT_CONNECTION_METHODS = new Set<string>([
	'eth_requestAccounts',
	'wallet_requestPermissions',
])

const ACCOUNT_ONLY_METHODS = new Set<string>([
	'eth_accounts',
	'eth_requestAccounts',
	'wallet_requestPermissions',
	'wallet_getPermissions',
	'wallet_getCapabilities',
])

export function isAccountConnectionMethod(method: string) {
	return ACCOUNT_CONNECTION_METHODS.has(method)
}

export function isAccountOnlyMethod(method: string) {
	return ACCOUNT_ONLY_METHODS.has(method)
}

// personal_ecRecover is pure computation, so like account-only methods it never needs the Interceptor RPC and stays local even on signer-only networks.
export function isAnsweredWithoutInterceptorRpc(method: string) {
	return isAccountOnlyMethod(method) || method === 'personal_ecRecover'
}
