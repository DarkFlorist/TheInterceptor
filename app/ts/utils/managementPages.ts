import type { TransactionOrMessageIdentifier } from '../types/interceptor-messages.js'
import { getSimulationStackTargetElementIdFromHash, getSimulationStackTargetHash } from './simulationStackTargets.js'

export type ManagementPage = 'websites' | 'address-book' | 'simulation-stack' | 'diagnostics' | 'settings'
export type ManagementOpenRequest = 'popup_openWebsiteAccess' | 'popup_openAddressBook' | 'popup_openSettings'
type ManagementTabTarget = {
	tabName: 'settingsView'
	targetHash: string
}
export type MountedManagementPages = Readonly<{
	websites: boolean
	'address-book': boolean
	'simulation-stack': boolean
	diagnostics: boolean
	settings: boolean
}>

const managementPages: readonly ManagementPage[] = ['websites', 'address-book', 'simulation-stack', 'diagnostics', 'settings']

export function getManagementPageFromHash(hash: string): ManagementPage {
	if (hash.startsWith('#origin:')) return 'websites'
	if (getSimulationStackTargetElementIdFromHash(hash) !== undefined) return 'simulation-stack'
	const hashPage = hash.startsWith('#') ? hash.slice(1) : hash
	return managementPages.find((page) => page === hashPage) ?? 'websites'
}

export function getManagementPageHash(page: ManagementPage) {
	return `#${ page }`
}

export function createMountedManagementPages(initialPage: ManagementPage): MountedManagementPages {
	return {
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
		case 'websites': return { ...mountedPages, websites: true }
		case 'address-book': return { ...mountedPages, 'address-book': true }
		case 'simulation-stack': return { ...mountedPages, 'simulation-stack': true }
		case 'diagnostics': return { ...mountedPages, diagnostics: true }
		case 'settings': return { ...mountedPages, settings: true }
	}
}

function getManagementPageFromOpenRequest(method: ManagementOpenRequest): ManagementPage {
	switch (method) {
		case 'popup_openWebsiteAccess': return 'websites'
		case 'popup_openAddressBook': return 'address-book'
		case 'popup_openSettings': return 'settings'
	}
}

export function getManagementTabTarget(method: ManagementOpenRequest): ManagementTabTarget {
	const page = getManagementPageFromOpenRequest(method)
	return {
		tabName: 'settingsView',
		targetHash: getManagementPageHash(page),
	}
}

export function getSimulationStackManagementTabTarget(identifier?: TransactionOrMessageIdentifier): ManagementTabTarget {
	return {
		tabName: 'settingsView',
		targetHash: identifier === undefined ? getManagementPageHash('simulation-stack') : getSimulationStackTargetHash(identifier),
	}
}

export function getManagementPageFromNavigationKey(currentPage: ManagementPage, key: string): ManagementPage | undefined {
	if (key === 'Home') return managementPages[0]
	if (key === 'End') return managementPages[managementPages.length - 1]
	if (key !== 'ArrowLeft' && key !== 'ArrowRight') return undefined

	const currentIndex = managementPages.indexOf(currentPage)
	const offset = key === 'ArrowRight' ? 1 : -1
	const nextIndex = (currentIndex + offset + managementPages.length) % managementPages.length
	return managementPages[nextIndex]
}
