import type { Website, WebsiteAccessArray } from '../types/websiteAccessTypes.js'

export const MAX_STORED_WEBSITE_ICON_LENGTH = 1_048_576

const DATA_IMAGE_ICON_PREFIX = /^data:image\//i

export function sanitizeStoredWebsiteIcon(icon: string | undefined): string | undefined {
	if (icon === undefined) return undefined
	if (!DATA_IMAGE_ICON_PREFIX.test(icon)) return undefined
	if (icon.length > MAX_STORED_WEBSITE_ICON_LENGTH) return undefined
	return icon
}

export function sanitizeWebsite(website: Website): Website {
	const icon = sanitizeStoredWebsiteIcon(website.icon)
	if (icon === website.icon) return website
	return { ...website, icon }
}

export function sanitizeWebsiteAccess(websiteAccess: WebsiteAccessArray): WebsiteAccessArray {
	let changed = false
	const sanitizedWebsiteAccess = websiteAccess.map((entry) => {
		const website = sanitizeWebsite(entry.website)
		if (website === entry.website) return entry
		changed = true
		return { ...entry, website }
	})
	return changed ? sanitizedWebsiteAccess : websiteAccess
}

export function mergeStoredWebsiteMetadata(existingWebsite: Website, nextWebsite: Website): Website {
	const sanitizedExistingWebsite = sanitizeWebsite(existingWebsite)
	const sanitizedNextWebsite = sanitizeWebsite(nextWebsite)
	const icon = sanitizedExistingWebsite.icon ?? sanitizedNextWebsite.icon
	const title = sanitizedExistingWebsite.title ?? sanitizedNextWebsite.title
	if (icon === existingWebsite.icon && title === existingWebsite.title) return existingWebsite
	return { ...existingWebsite, icon, title }
}
