import type { WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import { Semaphore } from '../utils/semaphore.js'
import { browserStorageLocalSet } from '../utils/storageUtils.js'
import { getParsedStorageValueOrDefault } from '../utils/storageDefaults.js'
import { sanitizeWebsiteAccess } from '../utils/websiteIcons.js'

// Owns normalized reads and serialized updates; registration reads this state without loading settings or update orchestration.
async function getNormalizedWebsiteAccessFromStorage() {
	const rawWebsiteAccess = await getParsedStorageValueOrDefault('websiteAccess', [])
	return { rawWebsiteAccess, sanitizedWebsiteAccess: sanitizeWebsiteAccess(rawWebsiteAccess) }
}

export async function getWebsiteAccess() {
	return (await getNormalizedWebsiteAccessFromStorage()).sanitizedWebsiteAccess
}

const websiteAccessSemaphore = new Semaphore(1)
export async function updateWebsiteAccess(updateFunc: (prevState: WebsiteAccessArray) => WebsiteAccessArray) {
	await websiteAccessSemaphore.execute(async () => {
		const { rawWebsiteAccess, sanitizedWebsiteAccess } = await getNormalizedWebsiteAccessFromStorage()
		const nextWebsiteAccess = sanitizeWebsiteAccess(updateFunc(sanitizedWebsiteAccess))
		if (nextWebsiteAccess === sanitizedWebsiteAccess && rawWebsiteAccess === sanitizedWebsiteAccess) return
		return await browserStorageLocalSet({ websiteAccess: nextWebsiteAccess })
	})
}
