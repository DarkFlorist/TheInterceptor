import { SITE_HTTP_API_ROUTES, matchSiteHttpApiRoute, matchesSiteHttpApiRoute, type SiteHttpApiAdapterId, type SiteHttpApiRoute, type SiteHttpApiRouteMatch } from '../../shared/ts/siteBehaviorPolicy.js'
import { prepareBalanceApiInterception } from './balanceApiInterception.js'
import { prepareSwapStatusApiInterception } from './swapStatusApiInterception.js'
import { preparePortfolioApiInterception } from './portfolioApiInterception.js'
import { createSiteHttpApiTransport, type ApplySiteHttpApiInterception, type PrepareSiteHttpApiInterception, type SiteHttpApiContext } from './siteHttpApiInterception.js'

// Adapters belong to the independent document-start feature bundle, outside the core wallet provider. Context and background admission gates control their use; private HTTP replies stay in the page.
const adapters: Readonly<Record<SiteHttpApiAdapterId, PrepareSiteHttpApiInterception>> = { balance: prepareBalanceApiInterception, swapStatus: prepareSwapStatusApiInterception, portfolio: preparePortfolioApiInterception }

// Routing is exclusive rather than ordered: overlapping descriptors are a policy error, never an implicit adapter precedence. Request-specific mismatches cannot issue network traffic because preparation receives no transport.
export async function prepareSiteHttpApiInterception(request: Request, context: SiteHttpApiContext, routes: readonly SiteHttpApiRoute[] = SITE_HTTP_API_ROUTES): Promise<ApplySiteHttpApiInterception | undefined> {
	const url = new URL(request.url)
	const matching: SiteHttpApiRouteMatch[] = []
	for (const route of routes) {
		const match = matchSiteHttpApiRoute(route, request.method, url)
		if (match !== undefined) matching.push(match)
	}
	if (matching.length > 1) throw new Error('Ambiguous site HTTP API interception routes.')
	const match = matching[0]
	if (match === undefined) return undefined
	const apply = await adapters[match.route.adapter](request, context, match)
	return apply === undefined ? undefined : async (send, requestRpc) => await apply(createSiteHttpApiTransport(request, match.route, send), requestRpc)
}

// Document-start capture consults the same endpoint descriptors as dispatch; all POSTs may also carry ordinary JSON-RPC reads.
export function shouldWaitForSiteHttpContext(method: string, inputUrl: string) {
	if (method.toUpperCase() === 'POST') return true
	const url = new URL(inputUrl)
	return SITE_HTTP_API_ROUTES.some((route) => matchesSiteHttpApiRoute(route, method.toUpperCase(), url))
}
