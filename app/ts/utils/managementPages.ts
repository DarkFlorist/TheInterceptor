import { isSimulationStackElementId, type SimulationStackRoute, type SimulationStackTarget } from './simulationStackTargets.js'

export const managementPages = ['home', 'websites', 'address-book', 'simulation-stack', 'diagnostics', 'settings'] as const
export type ManagementPage = (typeof managementPages)[number]

export type WebsitesRoute = { readonly page: 'websites', readonly websiteOrigin?: string }
export type ManagementRoute = WebsitesRoute | SimulationStackRoute | { readonly page: Exclude<ManagementPage, 'websites' | 'simulation-stack'> }

const WEBSITE_ORIGIN_KEY = 'origin'
const SIMULATION_STACK_TARGET_KEY = 'simulation-stack-target'
const SIMULATION_STACK_FOCUS_KEY = 'focus'
const LEGACY_WEBSITE_ORIGIN_PREFIX = '#origin:'
const LEGACY_SIMULATION_STACK_TARGET_PREFIX = `#${ SIMULATION_STACK_TARGET_KEY }=`

export function getManagementPageHash(page: ManagementPage) {
	return `#${ page }`
}

function isManagementPage(value: string): value is ManagementPage {
	return managementPages.some((page) => page === value)
}

function parseSimulationStackTarget(parameters: URLSearchParams): SimulationStackTarget | undefined {
	const elementId = parameters.get(SIMULATION_STACK_TARGET_KEY)
	if (elementId === null || !isSimulationStackElementId(elementId)) return undefined
	const focus = parameters.get(SIMULATION_STACK_FOCUS_KEY) ?? undefined
	return focus === undefined ? { elementId } : { elementId, focus }
}

function routeForPage(page: ManagementPage, parameters: URLSearchParams): ManagementRoute {
	if (page === 'websites') {
		const websiteOrigin = parameters.get(WEBSITE_ORIGIN_KEY) || undefined
		return websiteOrigin === undefined ? { page } : { page, websiteOrigin }
	}
	if (page === 'simulation-stack') {
		const stackTarget = parseSimulationStackTarget(parameters)
		return stackTarget === undefined ? { page } : { page, stackTarget }
	}
	return { page }
}

// Parses the management shell hash, including the pre-shell standalone formats (#origin:<origin> and #simulation-stack-target=<id>), into a typed route; undefined means an unknown route.
export function parseManagementRoute(hash: string): ManagementRoute | undefined {
	if (hash === '' || hash === '#') return { page: 'home' }
	if (hash.startsWith(LEGACY_WEBSITE_ORIGIN_PREFIX)) {
		const websiteOrigin = hash.slice(LEGACY_WEBSITE_ORIGIN_PREFIX.length)
		return websiteOrigin === '' ? undefined : { page: 'websites', websiteOrigin }
	}
	if (hash.startsWith(LEGACY_SIMULATION_STACK_TARGET_PREFIX)) return routeForPage('simulation-stack', new URLSearchParams(hash.slice(1)))
	const [pageName = '', query] = hash.slice(1).split('?', 2)
	if (!isManagementPage(pageName)) return undefined
	return routeForPage(pageName, new URLSearchParams(query ?? ''))
}

export function formatManagementRoute(route: ManagementRoute): string {
	const parameters = new URLSearchParams()
	if (route.page === 'websites' && route.websiteOrigin !== undefined) parameters.set(WEBSITE_ORIGIN_KEY, route.websiteOrigin)
	if (route.page === 'simulation-stack' && route.stackTarget !== undefined) {
		parameters.set(SIMULATION_STACK_TARGET_KEY, route.stackTarget.elementId)
		if (route.stackTarget.focus !== undefined) parameters.set(SIMULATION_STACK_FOCUS_KEY, route.stackTarget.focus)
	}
	const query = parameters.toString()
	return query === '' ? getManagementPageHash(route.page) : `${ getManagementPageHash(route.page) }?${ query }`
}

export function getManagementPageFromNavigationKey(currentPage: ManagementPage | undefined, key: string): ManagementPage | undefined {
	if (key === 'Home') return managementPages[0]
	if (key === 'End') return managementPages[managementPages.length - 1]
	if (key !== 'ArrowLeft' && key !== 'ArrowRight') return undefined
	if (currentPage === undefined) return key === 'ArrowRight' ? managementPages[0] : managementPages[managementPages.length - 1]

	const currentIndex = managementPages.indexOf(currentPage)
	const offset = key === 'ArrowRight' ? 1 : -1
	const nextIndex = (currentIndex + offset + managementPages.length) % managementPages.length
	return managementPages[nextIndex]
}
