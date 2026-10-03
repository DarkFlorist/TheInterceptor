import type { TransactionOrMessageIdentifier } from '../types/interceptor-messages.js'
import { getSimulationStackElementId } from './simulationStackTargets.js'

export const managementSections = [
	{ page: 'home', label: 'Home', icon: '../img/management-home.svg', description: '', openRequest: 'popup_openManagement' },
	{ page: 'websites', label: 'Websites', icon: '../img/internet.svg', description: 'Review website access and permissions.', openRequest: 'popup_openWebsiteAccess' },
	{ page: 'address-book', label: 'Address Book', icon: '../img/address-book.svg', description: 'Manage saved addresses and contacts.', openRequest: 'popup_openAddressBook' },
	{ page: 'simulation-stack', label: 'Simulation Stack', icon: '../img/simulation-stack.svg', description: 'Inspect pending and simulated activity.', openRequest: undefined },
	{ page: 'diagnostics', label: 'Diagnostics', icon: '../img/diagnostics.svg', description: 'Browse recorded errors and technical details.', openRequest: undefined },
	{ page: 'settings', label: 'Settings', icon: '../img/settings.svg', description: 'Configure networks and extension preferences.', openRequest: 'popup_openSettings' },
] as const

export type ManagementPage = (typeof managementSections)[number]['page']
export type ManagementOpenRequest = Exclude<(typeof managementSections)[number]['openRequest'], undefined>
export const managementPages: readonly ManagementPage[] = managementSections.map((section) => section.page)

const WEBSITE_ORIGIN_HASH_KEY = 'origin'
const LEGACY_WEBSITE_ORIGIN_HASH_PREFIX = '#origin:'
const SIMULATION_STACK_TARGET_HASH_KEY = 'simulation-stack-target'
const SIMULATION_STACK_TARGET_FOCUS_KEY = 'focus'
const LEGACY_SIMULATION_STACK_TARGET_HASH_PREFIX = `#${ SIMULATION_STACK_TARGET_HASH_KEY }=`

export const WEBSITE_ORIGIN_RADIO_NAME = WEBSITE_ORIGIN_HASH_KEY

export function getManagementPageHash(page: ManagementPage) {
	return `#${ page }`
}

function getManagementPageParameters(hash: string, page: ManagementPage) {
	const prefix = `${ getManagementPageHash(page) }?`
	return hash.startsWith(prefix) ? new URLSearchParams(hash.slice(prefix.length)) : undefined
}

export function getManagementPageFromHash(hash: string): ManagementPage | undefined {
	if (hash === '' || hash === '#') return 'home'
	// Old detail links remain valid after the routes gained tab names.
	if (hash.startsWith(LEGACY_WEBSITE_ORIGIN_HASH_PREFIX) && hash.length > LEGACY_WEBSITE_ORIGIN_HASH_PREFIX.length) return 'websites'
	if (hash.startsWith(LEGACY_SIMULATION_STACK_TARGET_HASH_PREFIX)) return 'simulation-stack'
	return managementSections.find(({ page }) => hash === getManagementPageHash(page) || hash.startsWith(`${ getManagementPageHash(page) }?`))?.page
}

export function getWebsiteListHash() {
	return getManagementPageHash('websites')
}

export function getWebsiteOriginFromHash(hash: string): string | undefined {
	const parameters = getManagementPageParameters(hash, 'websites')
	if (parameters !== undefined) return parameters.get(WEBSITE_ORIGIN_HASH_KEY) || undefined
	if (!hash.startsWith(LEGACY_WEBSITE_ORIGIN_HASH_PREFIX)) return undefined
	return hash.slice(LEGACY_WEBSITE_ORIGIN_HASH_PREFIX.length) || undefined
}

export function getWebsiteOriginHash(origin: string): string {
	return `${ getWebsiteListHash() }?${ new URLSearchParams({ [WEBSITE_ORIGIN_HASH_KEY]: origin }).toString() }`
}

export function getSimulationStackTargetHash(identifier: TransactionOrMessageIdentifier, focusToken = Date.now().toString(36)) {
	const hashParameters = new URLSearchParams()
	hashParameters.set(SIMULATION_STACK_TARGET_HASH_KEY, getSimulationStackElementId(identifier))
	hashParameters.set(SIMULATION_STACK_TARGET_FOCUS_KEY, focusToken)
	return `${ getManagementPageHash('simulation-stack') }?${ hashParameters.toString() }`
}

export function getSimulationStackTargetElementIdFromHash(hash: string) {
	const parameters = getManagementPageParameters(hash, 'simulation-stack')
		?? (hash.startsWith(LEGACY_SIMULATION_STACK_TARGET_HASH_PREFIX) ? new URLSearchParams(hash.slice(1)) : undefined)
	const targetElementId = parameters?.get(SIMULATION_STACK_TARGET_HASH_KEY)
	if (targetElementId === null || targetElementId === undefined) return undefined
	if (!/^simulation-stack-(transaction|message)-0x[a-f0-9]+$/.test(targetElementId)) return undefined
	return targetElementId
}

export function getManagementHashForOpenRequest(method: ManagementOpenRequest): string {
	const page = managementSections.find((section) => section.openRequest === method)?.page
	if (page === undefined) throw new Error(`Unknown management open request: ${ method }`)
	return getManagementPageHash(page)
}

export function getSimulationStackManagementHash(identifier?: TransactionOrMessageIdentifier): string {
	return identifier === undefined ? getManagementPageHash('simulation-stack') : getSimulationStackTargetHash(identifier)
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
