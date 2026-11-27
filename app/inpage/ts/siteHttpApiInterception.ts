import type { SiteHttpApiDerivedRequestId, SiteHttpApiRoute, SiteHttpApiRouteMatch } from '../../shared/ts/siteBehaviorPolicy.js'

export type RpcRead = { readonly jsonrpc: '2.0', readonly id: string | number | null, readonly method: string, readonly params?: readonly unknown[] }
export type SiteHttpApiContext = { readonly chainId: string, readonly address?: string }
export type ApplySiteHttpApiInterception = (send: (request: Request) => Promise<Response>, requestRpc: (chainId: string, request: RpcRead) => Promise<unknown>) => Promise<Response>
export type SiteHttpApiTransport = {
	readonly sendOriginal: () => Promise<Response>
	readonly sendDerived: (id: SiteHttpApiDerivedRequestId, payload: unknown) => Promise<Response>
}
export type ApplyPreparedSiteHttpApiInterception = (http: SiteHttpApiTransport, requestRpc: (chainId: string, request: RpcRead) => Promise<unknown>) => Promise<Response>

// Adapters receive capabilities for their original request and named policy endpoints, never an unrestricted HTTP sender.
export function createSiteHttpApiTransport(request: Request, route: SiteHttpApiRoute, send: (request: Request) => Promise<Response>): SiteHttpApiTransport {
	return {
		sendOriginal: async () => await send(request),
		sendDerived: async (id, payload) => {
			const endpoint = route.derivedRequests?.[id]
			if (endpoint === undefined) throw new Error(`Undeclared site HTTP API request: ${ id }`)
			const url = new URL(endpoint.path, route.origin)
			if (url.origin !== route.origin || url.pathname !== endpoint.path || url.search !== '' || url.hash !== '') throw new Error(`Invalid site HTTP API endpoint: ${ id }`)
			return await send(new Request(url, { method: endpoint.method, headers: request.headers, credentials: request.credentials, mode: request.mode, signal: request.signal, body: JSON.stringify(payload) }))
		},
	}
}

// Preparation consumes the exact dispatcher match and validates request data. It cannot send HTTP or RPC. A match returns its exclusive response handler, which must return a response or throw and never falls through to another adapter.
export type PrepareSiteHttpApiInterception = (request: Request, context: SiteHttpApiContext, matchedRoute: SiteHttpApiRouteMatch) => Promise<ApplyPreparedSiteHttpApiInterception | undefined>
