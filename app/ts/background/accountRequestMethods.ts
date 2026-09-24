const ACCOUNT_CONNECTION_METHODS = new Set<string>([
	'eth_requestAccounts',
	'wallet_requestPermissions',
])

const ACCOUNT_ONLY_METHODS = [
	'eth_accounts',
	'eth_requestAccounts',
	'wallet_requestPermissions',
	'wallet_getPermissions',
	'wallet_getCapabilities',
] as const

export type AccountOnlyMethod = typeof ACCOUNT_ONLY_METHODS[number]

const accountOnlyMethods = new Set<string>(ACCOUNT_ONLY_METHODS)

export function isAccountConnectionMethod(method: string) {
	return ACCOUNT_CONNECTION_METHODS.has(method)
}

export function isAccountOnlyMethod(method: string): method is AccountOnlyMethod {
	return accountOnlyMethods.has(method)
}
