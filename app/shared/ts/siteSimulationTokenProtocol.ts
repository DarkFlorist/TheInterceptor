// Private HTTP-adapter requests travel inside site_rpc_request, never through the public wallet method surface.
export const SITE_SIMULATION_TOKEN_METHODS = {
	addresses: 'interceptor_getSimulationTokens',
	metadata: 'interceptor_getSimulationTokenMetadata',
} as const

type SiteSimulationTokenMethod = typeof SITE_SIMULATION_TOKEN_METHODS[keyof typeof SITE_SIMULATION_TOKEN_METHODS]
export type SiteSimulationTokenRequest = { readonly method: SiteSimulationTokenMethod }
type SiteSimulationTokenRpcRequest = SiteSimulationTokenRequest & { readonly jsonrpc: '2.0', readonly id: string | number | null }

export function createSiteSimulationTokenRequest(kind: keyof typeof SITE_SIMULATION_TOKEN_METHODS, id: SiteSimulationTokenRpcRequest['id']): SiteSimulationTokenRpcRequest {
	return { jsonrpc: '2.0', id, method: SITE_SIMULATION_TOKEN_METHODS[kind] }
}

export function isSiteSimulationTokenMethod(method: string): method is SiteSimulationTokenMethod {
	return method === SITE_SIMULATION_TOKEN_METHODS.addresses || method === SITE_SIMULATION_TOKEN_METHODS.metadata
}

export function isSiteSimulationTokenRequest(request: { readonly method: string }): request is SiteSimulationTokenRequest {
	return isSiteSimulationTokenMethod(request.method)
}
