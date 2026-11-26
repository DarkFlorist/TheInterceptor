export const INTERNAL_PROVIDER_METHODS = [
	'connected_to_signer',
	'eth_accounts_reply',
	'InterceptorError',
	'safe_apps_request',
	'site_rpc_request',
	'signer_chainChanged',
	'signer_reply',
	'wallet_switchEthereumChain_reply',
] as const

const internalProviderMethods: ReadonlySet<string> = new Set(INTERNAL_PROVIDER_METHODS)
export const isInternalProviderMethod = (method: string) => internalProviderMethods.has(method)
