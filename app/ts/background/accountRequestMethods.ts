const ACCOUNT_CONNECTION_METHODS = new Set<string>([
	'eth_requestAccounts',
	'wallet_requestPermissions',
])

const ACCOUNT_ONLY_METHODS = new Set<string>([
	'eth_accounts',
	'eth_requestAccounts',
	'wallet_requestPermissions',
	'wallet_getPermissions',
])

export function isAccountConnectionMethod(method: string) {
	return ACCOUNT_CONNECTION_METHODS.has(method)
}

export function isAccountOnlyMethod(method: string) {
	return ACCOUNT_ONLY_METHODS.has(method)
}
