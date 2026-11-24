import { formatManagementRoute, parseManagementRoute, type ManagementPage, type ManagementRoute } from './managementPages.js'

// The only module that reads or writes the page location for management routes; test/tests/managementRouteOwnership.test.ts enforces this, so panels receive their route as props from the shell instead.

export function readManagementRoute(): ManagementRoute | undefined {
	return parseManagementRoute(globalThis.location.hash)
}

export type ManagementNavigationOptions = { readonly replace?: boolean }

// replace updates the current history entry instead of adding one, for selections the page makes on its own (such as auto-selecting the only search result) rather than ones the user asked for.
export function writeManagementRoute(route: ManagementRoute, { replace = false }: ManagementNavigationOptions = {}) {
	const hash = formatManagementRoute(route)
	if (!replace) {
		globalThis.location.hash = hash
		return
	}
	globalThis.history.replaceState(globalThis.history.state, '', `${ globalThis.location.pathname }${ globalThis.location.search }${ hash }`)
}

// Rewrites a recognized but non-canonical hash, such as a pre-shell #origin: link, in place so reloads and the history entry use the canonical form.
export function replaceWithCanonicalManagementHash() {
	const route = readManagementRoute()
	const currentHash = globalThis.location.hash
	if (route === undefined || currentHash === '' || currentHash === '#') return
	const canonicalHash = formatManagementRoute(route)
	if (canonicalHash === currentHash) return
	globalThis.history.replaceState(globalThis.history.state, '', `${ globalThis.location.pathname }${ globalThis.location.search }${ canonicalHash }`)
}

export function subscribeToManagementRoute(onRouteChange: (route: ManagementRoute | undefined) => void) {
	const handleHashChange = () => {
		replaceWithCanonicalManagementHash()
		onRouteChange(readManagementRoute())
	}
	globalThis.addEventListener('hashchange', handleHashChange)
	return () => globalThis.removeEventListener('hashchange', handleHashChange)
}

// Saved links to the pre-shell standalone pages land here and continue in the management shell at the matching route.
export function redirectStandalonePageToManagementShell(page: ManagementPage, managementShellPath: string) {
	const savedRoute = readManagementRoute()
	const route: ManagementRoute = savedRoute !== undefined && savedRoute.page === page ? savedRoute : { page }
	globalThis.location.replace(`${ managementShellPath }${ formatManagementRoute(route) }`)
}
