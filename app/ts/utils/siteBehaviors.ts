// Behavioral policy is separate from websiteData's presentation warnings. Page transports receive this policy as context rather than compiling their own site list.
import { SIMULATED_SITE_RPC_METHODS, SITE_BEHAVIOR_OVERRIDES, type SiteBehavior } from '../../shared/ts/siteBehaviorPolicy.js'
export * from '../../shared/ts/siteBehaviorPolicy.js'
// Resolve universal HTTP(S) read-only policy plus nonstandard transport overrides; undefined means an invalid origin. Live permissions still authorize every request separately.
export function resolveSiteBehavior(origin: string, overrides: readonly SiteBehavior[] = SITE_BEHAVIOR_OVERRIDES): SiteBehavior | undefined {
	let url: URL
	try { url = new URL(origin) } catch (error: unknown) {
		if (error instanceof TypeError) return undefined
		throw error
	}
	if (url.origin !== origin || !['https:', 'http:'].includes(url.protocol)) return undefined
	return overrides.find((behavior) => behavior.origin === origin) ?? { origin, rpcReads: { methods: SIMULATED_SITE_RPC_METHODS, chainRoutedProxyPaths: [] } }
}
