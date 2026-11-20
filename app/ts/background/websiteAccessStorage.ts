import { browserStorageLocalSafeParse, browserStorageLocalSet } from '../utils/storageUtils.js'
import { sanitizeWebsiteAccess } from '../utils/websiteIcons.js'

// Read access state without importing the complete settings module; content-script registration derives its exclusions from the same normalized storage value.
export async function getNormalizedWebsiteAccessFromStorage() {
	const storedItems = await browser.storage.local.get('websiteAccess')
	const rawValue: unknown = Reflect.get(storedItems, 'websiteAccess')
	const parsed = browserStorageLocalSafeParse(storedItems)
	if (rawValue !== undefined && parsed?.websiteAccess === undefined) {
		console.warn('websiteAccess was corrupt:')
		console.warn(rawValue)
		await browserStorageLocalSet({ websiteAccess: [] })
	}
	const rawWebsiteAccess = parsed?.websiteAccess ?? []
	return { rawWebsiteAccess, sanitizedWebsiteAccess: sanitizeWebsiteAccess(rawWebsiteAccess) }
}

export async function getWebsiteAccess() {
	return (await getNormalizedWebsiteAccessFromStorage()).sanitizedWebsiteAccess
}
