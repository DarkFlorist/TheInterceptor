import { ACCOUNT_CONNECTION_METHODS } from '../../shared/ts/accountRequestMethods.js'
export { isAccountConnectionMethod } from '../../shared/ts/accountRequestMethods.js'

const ACCOUNT_ONLY_METHODS = new Set<string>([
	'eth_accounts',
	...ACCOUNT_CONNECTION_METHODS,
	'wallet_getPermissions',
	'wallet_getCapabilities',
])

export function isAccountOnlyMethod(method: string) {
	return ACCOUNT_ONLY_METHODS.has(method)
}
