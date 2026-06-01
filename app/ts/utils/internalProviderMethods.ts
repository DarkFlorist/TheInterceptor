export const INTERNAL_PROVIDER_METHODS = [
	'connected_to_signer',
	'eth_accounts_reply',
	'InterceptorError',
	'signer_chainChanged',
	'signer_reply',
	'wallet_switchEthereumChain_reply',
] as const

export const isInternalProviderMethod = (method: string) => INTERNAL_PROVIDER_METHODS.some((internalMethod) => internalMethod === method)
