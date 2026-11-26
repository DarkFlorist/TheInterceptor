// Canonical HTTP behavior policy: page origins select nonstandard RPC envelopes; vendor endpoint routes apply to any page in an approved Gnosis Safe simulation session using those APIs. These descriptors never grant permission.

// Simulation represents the native currency with this sentinel; indexed vendor APIs may map it to their own native address.
export const SIMULATION_NATIVE_TOKEN_ADDRESS = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
export const SIMULATED_SITE_RPC_METHODS = ['eth_call', 'eth_getBalance', 'eth_getCode', 'eth_getStorageAt', 'eth_getTransactionCount', 'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getLogs', 'eth_estimateGas', 'eth_chainId', 'net_version', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory'] as const
export type SiteBehavior = { readonly origin: string, readonly rpcReads: { readonly methods: readonly typeof SIMULATED_SITE_RPC_METHODS[number][], readonly chainRoutedProxyPaths: readonly string[] } }
// Optional origin-specific transport overrides, not an allowlist. Standard JSON-RPC works on every approved HTTP(S) origin.
export const SITE_BEHAVIOR_OVERRIDES: readonly SiteBehavior[] = [
	{ origin: 'https://app.aave.com', rpcReads: { methods: SIMULATED_SITE_RPC_METHODS, chainRoutedProxyPaths: ['/api/rpc-proxy'] } },
]

export type SiteHttpApiAdapterId = SiteHttpApiRoute['adapter']
export type SiteHttpApiDerivedRequestId = 'portfolio' | 'tokenPrices'
export type SiteHttpApiDerivedRequest = { readonly method: 'POST', readonly path: string }
type SiteHttpApiRouteBase = { readonly method: 'GET' | 'POST', readonly origin: string, readonly path: RegExp, readonly derivedRequests?: Readonly<Partial<Record<SiteHttpApiDerivedRequestId, SiteHttpApiDerivedRequest>>> }
export type SiteHttpApiRoute = SiteHttpApiRouteBase & (
	| { readonly adapter: 'balance' | 'swapStatus' }
	| { readonly adapter: 'portfolio', readonly responseKind: 'portfolio' | 'walletBalances' }
)

const portfolioRequest: SiteHttpApiDerivedRequest = { method: 'POST', path: '/data.v1.DataApiService/GetPortfolio' }
const tokenPricesRequest: SiteHttpApiDerivedRequest = { method: 'POST', path: '/data.v1.DataApiService/GetTokenPrices' }
const walletBalancesPath = '/data.v1.DataApiService/GetWalletBalances'
const exactPath = (path: string) => new RegExp(`^${ path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }$`)

export const SITE_HTTP_API_ROUTES: readonly SiteHttpApiRoute[] = [
	{ adapter: 'balance', method: 'GET', origin: 'https://proxy-app.1inch.com', path: /^\/v2\.0\/balance\/v1\.2\/(?<chainId>[1-9][0-9]{0,77})\/allowancesAndBalances\/(?<spender>0x[0-9a-f]{40})\/(?<account>0x[0-9a-f]{40})\/?$/i },
	{ adapter: 'swapStatus', method: 'GET', origin: 'https://entry-gateway.backend-prod.api.uniswap.org', path: /^\/swaps$/ },
	{ adapter: 'portfolio', method: 'POST', origin: 'https://entry-gateway.backend-prod.api.uniswap.org', path: exactPath(portfolioRequest.path), responseKind: 'portfolio', derivedRequests: { tokenPrices: tokenPricesRequest } },
	{ adapter: 'portfolio', method: 'POST', origin: 'https://entry-gateway.backend-prod.api.uniswap.org', path: exactPath(walletBalancesPath), responseKind: 'walletBalances', derivedRequests: { portfolio: portfolioRequest, tokenPrices: tokenPricesRequest } },
]

type SiteHttpApiRouteParameters = { readonly kind: 'balance', readonly chainId: bigint, readonly spender: string, readonly account: string } | { readonly kind: 'none' }
export type SiteHttpApiRouteMatch = { readonly route: SiteHttpApiRoute, readonly parameters: SiteHttpApiRouteParameters }

export function matchSiteHttpApiRoute(route: SiteHttpApiRoute, method: string, url: URL): SiteHttpApiRouteMatch | undefined {
	if (route.method !== method || route.origin !== url.origin) return undefined
	const captures = route.path.exec(url.pathname)
	if (captures === null) return undefined
	if (route.adapter !== 'balance') return { route, parameters: { kind: 'none' } }
	const { chainId: chain, spender, account } = captures.groups ?? {}
	if (chain === undefined || !/^[1-9][0-9]{0,77}$/.test(chain) || spender === undefined || !/^0x[0-9a-f]{40}$/i.test(spender) || account === undefined || !/^0x[0-9a-f]{40}$/i.test(account)) throw new Error('Balance API route must provide valid named parameters: chainId, spender and account.')
	return { route, parameters: { kind: 'balance', chainId: BigInt(chain), spender, account } }
}

export function matchesSiteHttpApiRoute(route: SiteHttpApiRoute, method: string, url: URL) {
	return matchSiteHttpApiRoute(route, method, url) !== undefined
}
