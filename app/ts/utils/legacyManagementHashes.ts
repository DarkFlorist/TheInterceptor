import { getWebsiteOriginHash } from './websiteAccessRoutes.js'

const WEBSITE_ORIGIN_PREFIX = '#origin:'
const SIMULATION_STACK_TARGET_PREFIX = '#simulation-stack-target='

export function getCanonicalManagementHash(hash: string): string | undefined {
	if (hash.startsWith(WEBSITE_ORIGIN_PREFIX)) {
		const origin = hash.slice(WEBSITE_ORIGIN_PREFIX.length)
		return origin === '' ? undefined : getWebsiteOriginHash(origin)
	}
	if (hash.startsWith(SIMULATION_STACK_TARGET_PREFIX)) return `#simulation-stack?${ hash.slice(1) }`
	return undefined
}

export function installLegacyManagementHashRedirect() {
	if (globalThis.location === undefined || globalThis.history === undefined) return
	const redirect = () => {
		const canonicalHash = getCanonicalManagementHash(globalThis.location.hash)
		if (canonicalHash === undefined) return
		globalThis.history.replaceState(globalThis.history.state, '', `${ globalThis.location.pathname }${ globalThis.location.search }${ canonicalHash }`)
	}
	redirect()
	globalThis.addEventListener?.('hashchange', redirect)
}
