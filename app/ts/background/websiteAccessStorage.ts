import { getParsedStorageValueOrDefault } from '../utils/storageDefaults.js'
import { sanitizeWebsiteAccess } from '../utils/websiteIcons.js'

// Read access state without importing the complete settings module; content-script registration derives its exclusions from the same normalized storage value.
export async function getNormalizedWebsiteAccessFromStorage() {
	const rawWebsiteAccess = await getParsedStorageValueOrDefault('websiteAccess', [])
	return { rawWebsiteAccess, sanitizedWebsiteAccess: sanitizeWebsiteAccess(rawWebsiteAccess) }
}

export async function getWebsiteAccess() {
	return (await getNormalizedWebsiteAccessFromStorage()).sanitizedWebsiteAccess
}
