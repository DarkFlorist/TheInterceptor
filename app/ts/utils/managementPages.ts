import type { TransactionOrMessageIdentifier } from '../types/interceptor-messages.js'
import { getSimulationStackTargetElementIdFromHash, getSimulationStackTargetHash } from './simulationStackTargets.js'
import { isWebsiteOriginHash } from './websiteAccessHash.js'

export type ManagementPage = 'home' | 'websites' | 'address-book' | 'simulation-stack' | 'diagnostics' | 'settings'
export type ManagementOpenRequest = 'popup_openManagement' | 'popup_openWebsiteAccess' | 'popup_openAddressBook' | 'popup_openSettings'
export type MountedManagementPages = Readonly<{
	home: boolean
	websites: boolean
	'address-book': boolean
	'simulation-stack': boolean
	diagnostics: boolean
	settings: boolean
}>

export const managementPages: readonly ManagementPage[] = ['home', 'websites', 'address-book', 'simulation-stack', 'diagnostics', 'settings']

export function getManagementPageFromHash(hash: string): ManagementPage | undefined {
	if (hash === '' || hash === '#') return 'home'
	if (isWebsiteOriginHash(hash)) return 'websites'
	if (getSimulationStackTargetElementIdFromHash(hash) !== undefined) return 'simulation-stack'
	const hashPage = hash.startsWith('#') ? hash.slice(1) : hash
	return managementPages.find((page) => page === hashPage)
}

export function getManagementPageHash(page: ManagementPage) {
	return `#${ page }`
}

export function createMountedManagementPages(initialPage: ManagementPage | undefined): MountedManagementPages {
	return {
		home: initialPage === 'home',
		websites: initialPage === 'websites',
		'address-book': initialPage === 'address-book',
		'simulation-stack': initialPage === 'simulation-stack',
		diagnostics: initialPage === 'diagnostics',
		settings: initialPage === 'settings',
	}
}

export function mountManagementPage(mountedPages: MountedManagementPages, page: ManagementPage): MountedManagementPages {
	if (mountedPages[page]) return mountedPages
	switch (page) {
		case 'home': return { ...mountedPages, home: true }
		case 'websites': return { ...mountedPages, websites: true }
		case 'address-book': return { ...mountedPages, 'address-book': true }
		case 'simulation-stack': return { ...mountedPages, 'simulation-stack': true }
		case 'diagnostics': return { ...mountedPages, diagnostics: true }
		case 'settings': return { ...mountedPages, settings: true }
	}
}

function getManagementPageFromOpenRequest(method: ManagementOpenRequest): ManagementPage {
	switch (method) {
		case 'popup_openManagement': return 'home'
		case 'popup_openWebsiteAccess': return 'websites'
		case 'popup_openAddressBook': return 'address-book'
		case 'popup_openSettings': return 'settings'
	}
}

export function getManagementHashForOpenRequest(method: ManagementOpenRequest): string {
	const page = getManagementPageFromOpenRequest(method)
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
