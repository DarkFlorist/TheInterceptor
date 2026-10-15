export const managementPages = ['home', 'websites', 'address-book', 'simulation-stack', 'diagnostics', 'settings'] as const
export type ManagementPage = (typeof managementPages)[number]

export function getManagementPageHash(page: ManagementPage) {
	return `#${ page }`
}

export function getManagementPageParameters(hash: string, page: ManagementPage) {
	const prefix = `${ getManagementPageHash(page) }?`
	return hash.startsWith(prefix) ? new URLSearchParams(hash.slice(prefix.length)) : undefined
}

export function getManagementPageFromHash(hash: string): ManagementPage | undefined {
	if (hash === '' || hash === '#') return 'home'
	return managementPages.find((page) => hash === getManagementPageHash(page) || hash.startsWith(`${ getManagementPageHash(page) }?`))
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
