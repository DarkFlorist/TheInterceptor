import { updateContentScriptRegistrations } from '../utils/contentScriptsRegistration.js'
import type { WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import { Semaphore } from '../utils/semaphore.js'
import { browserStorageLocalSet } from '../utils/storageUtils.js'
import { getParsedStorageValueOrDefaultFromItems } from '../utils/storageDefaults.js'
import { sanitizeWebsiteAccess } from '../utils/websiteIcons.js'

// Owns normalized reads and serialized domain updates, including disabled-site registration refresh. The registration service has no background imports; error reporting loads only if registration fails.
async function getNormalizedWebsiteAccessFromStorageItems(storedItems: Readonly<Record<string, unknown>>) {
	const rawWebsiteAccess = await getParsedStorageValueOrDefaultFromItems(storedItems, 'websiteAccess', [])
	return { rawWebsiteAccess, sanitizedWebsiteAccess: sanitizeWebsiteAccess(rawWebsiteAccess) }
}

export async function getWebsiteAccessFromStorageItems(storedItems: Readonly<Record<string, unknown>>) {
	return (await getNormalizedWebsiteAccessFromStorageItems(storedItems)).sanitizedWebsiteAccess
}

export async function getWebsiteAccess() {
	return await getWebsiteAccessFromStorageItems(await browser.storage.local.get('websiteAccess'))
}

export const getInterceptorDisabledSites = (websiteAccess: WebsiteAccessArray) => websiteAccess.filter((entry) => entry.interceptorDisabled === true).map((entry) => entry.website.websiteOrigin)

function haveSameDisabledSites(previousWebsiteAccess: WebsiteAccessArray, nextWebsiteAccess: WebsiteAccessArray) {
	const previousDisabledSites = new Set(getInterceptorDisabledSites(previousWebsiteAccess))
	const nextDisabledSites = new Set(getInterceptorDisabledSites(nextWebsiteAccess))
	return previousDisabledSites.size === nextDisabledSites.size && [...previousDisabledSites].every((origin) => nextDisabledSites.has(origin))
}

const websiteAccessSemaphore = new Semaphore(1)
export async function updateWebsiteAccess(updateFunc: (prevState: WebsiteAccessArray) => WebsiteAccessArray) {
	return await websiteAccessSemaphore.execute(async () => {
		const { rawWebsiteAccess, sanitizedWebsiteAccess } = await getNormalizedWebsiteAccessFromStorageItems(await browser.storage.local.get('websiteAccess'))
		const nextWebsiteAccess = sanitizeWebsiteAccess(updateFunc(sanitizedWebsiteAccess))
		if (nextWebsiteAccess === sanitizedWebsiteAccess && rawWebsiteAccess === sanitizedWebsiteAccess) return false
		await browserStorageLocalSet({ websiteAccess: nextWebsiteAccess })
		const disabledSitesChanged = !haveSameDisabledSites(sanitizedWebsiteAccess, nextWebsiteAccess)
		if (disabledSitesChanged) {
			await updateContentScriptRegistrations({
				readDisabledSites: async () => getInterceptorDisabledSites(await getWebsiteAccess()),
				reportError: async (error, context) => {
					const { reportUnexpectedError } = await import('../utils/errors.js')
					await reportUnexpectedError(error, context)
				},
			})
		}
		return disabledSitesChanged
	})
}
