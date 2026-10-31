export const internalProviderMethods = {
	begin_signer_provider_selection: true,
	connected_to_signer: true,
	eth_accounts_reply: true,
	finish_signer_provider_selection: true,
	InterceptorError: true,
	safe_apps_request: true,
	signer_chainChanged: true,
	signer_provider_selected: true,
	signer_providers_changed: true,
	signer_reply: true,
	wallet_switchEthereumChain_reply: true,
} as const

export type InternalProviderMethod = keyof typeof internalProviderMethods

const methods = new Set<string>(Object.keys(internalProviderMethods))
const hasMethod = methods.has.bind(methods)
export const isInternalProviderMethod = (method: string) => hasMethod(method)
