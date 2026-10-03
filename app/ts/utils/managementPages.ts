import type { TransactionOrMessageIdentifier } from '../types/interceptor-messages.js'
import { getSimulationStackTargetHash } from './simulationStackTargets.js'

export type ManagementPage = 'home' | 'websites' | 'address-book' | 'simulation-stack' | 'diagnostics' | 'settings'
export type ManagementOpenRequest = 'popup_openManagement' | 'popup_openWebsiteAccess' | 'popup_openAddressBook' | 'popup_openSettings'
export const managementPages: readonly ManagementPage[] = ['home', 'websites', 'address-book', 'simulation-stack', 'diagnostics', 'settings']

export function getManagementPageFromHash(hash: string): ManagementPage | undefined {
	if (hash === '' || hash === '#') return 'home'
	if (hash.startsWith('#websites?')) return 'websites'
	if (hash.startsWith('#simulation-stack?')) return 'simulation-stack'
	// Preserve deep links created by earlier releases without parsing page-owned data.
	if (hash.startsWith('#origin:') && hash.length > '#origin:'.length) return 'websites'
	if (hash.startsWith('#simulation-stack-target=')) return 'simulation-stack'
	const hashPage = hash.startsWith('#') ? hash.slice(1) : hash
	return managementPages.find((page) => page === hashPage)
}

export function getManagementPageHash(page: ManagementPage) {
	return `#${ page }`
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
