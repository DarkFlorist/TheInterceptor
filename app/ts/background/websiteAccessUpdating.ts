import type { WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import { refreshContentScriptInjectionAfterAccessChange } from '../utils/contentScriptsUpdating.js'
import { updateWebsiteAccess } from './settings.js'

export async function updateWebsiteAccessAndContentScriptInjectionStrategy(update: (previousWebsiteAccess: WebsiteAccessArray) => WebsiteAccessArray) {
	let previousAccess: WebsiteAccessArray = []
	let nextAccess: WebsiteAccessArray = []
	await updateWebsiteAccess((previousWebsiteAccess) => {
		const nextWebsiteAccess = update(previousWebsiteAccess)
		previousAccess = previousWebsiteAccess
		nextAccess = nextWebsiteAccess
		return nextWebsiteAccess
	})
	return await refreshContentScriptInjectionAfterAccessChange(previousAccess, nextAccess)
}
