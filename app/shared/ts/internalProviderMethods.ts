export const INTERNAL_PROVIDER_ADMISSION_METHODS = ['safe_apps_request', 'site_rpc_request'] as const
export type InternalProviderAdmissionMethod = typeof INTERNAL_PROVIDER_ADMISSION_METHODS[number]

export const INTERNAL_PROVIDER_METHODS = [
	'connected_to_signer',
	'eth_accounts_reply',
	'InterceptorError',
	...INTERNAL_PROVIDER_ADMISSION_METHODS,
	'signer_chainChanged',
	'signer_reply',
	'wallet_switchEthereumChain_reply',
] as const

const internalProviderMethods: ReadonlySet<string> = new Set(INTERNAL_PROVIDER_METHODS)
export const isInternalProviderMethod = (method: string) => internalProviderMethods.has(method)
