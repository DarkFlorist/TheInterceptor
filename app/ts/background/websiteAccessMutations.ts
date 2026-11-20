import type { Website, WebsiteAccess, WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import type { EthereumAddress } from '../types/wire-types.js'
import { modifyObject } from '../utils/typescript.js'
import { isLegacyWebsiteOriginForCanonicalOrigin } from '../utils/websiteOrigin.js'

// Pure changes to website-access data live here. The handler-level workflow in applyWebsiteAccessUpdate.ts owns persistence, injection refresh, reloads and approval reconciliation.
export type WebsiteAccessMutation = (previousWebsiteAccess: WebsiteAccessArray) => WebsiteAccessArray

export const withInterceptorDisabledForWebsite = (website: Website, interceptorDisabled: boolean): WebsiteAccessMutation => (previousWebsiteAccess) => {
	let foundExactEntry = false
	const updatedWebsiteAccess = previousWebsiteAccess.map((entry) => {
		if (entry.website.websiteOrigin === website.websiteOrigin) {
			foundExactEntry = true
			return { ...entry, interceptorDisabled }
		}
		// Only re-enabling clears scheme-ambiguous legacy disables; disabling must leave them in place so the other scheme they alias stays disabled.
		if (!interceptorDisabled && entry.interceptorDisabled === true && isLegacyWebsiteOriginForCanonicalOrigin(entry.website.websiteOrigin, website.websiteOrigin)) {
			return { ...entry, interceptorDisabled: false }
		}
		return entry
	})
	if (foundExactEntry) return updatedWebsiteAccess
	return [...updatedWebsiteAccess, { website, addressAccess: [], interceptorDisabled }]
}

export const withExternalRequestsBlockedOrAllowed = (website: Website, shouldBlock: boolean): WebsiteAccessMutation => (previousAccessList) => previousAccessList.map((access) => {
	if (access.website.websiteOrigin !== website.websiteOrigin) return access
	return modifyObject(access, { declarativeNetRequestBlockMode: shouldBlock ? 'block-all' : 'disabled' })
})

export const withoutAddressAccess = (websiteOrigin: string, address: EthereumAddress): WebsiteAccessMutation => (previousAccessList) => previousAccessList.map((access) => {
	if (access.website.websiteOrigin !== websiteOrigin || !access.addressAccess) return access
	return modifyObject(access, { addressAccess: access.addressAccess.filter((addressAccess) => addressAccess.address !== address) })
})

export const withAddressAccessForWebsite = (websiteOrigin: string, address: EthereumAddress, allowAccess: boolean): WebsiteAccessMutation => (previousAccessList) => previousAccessList.map((access) => {
	if (access.website.websiteOrigin !== websiteOrigin || access.addressAccess === undefined) return access
	const addressAccess = access.addressAccess.map((entry) => entry.address === address ? modifyObject(entry, { access: allowAccess }) : entry)
	return modifyObject(access, { addressAccess })
})

export const withoutWebsiteAccess = (websiteOrigin: string): WebsiteAccessMutation => (previousAccess) => previousAccess.filter((access) => access.website.websiteOrigin !== websiteOrigin)

export const withWebsiteAccessChanges = (changes: readonly { readonly newEntry: WebsiteAccess, readonly removed: boolean }[]): WebsiteAccessMutation => (previousAccess) => {
	const withEntriesRemoved = previousAccess.filter((access) => changes.find((change) => change.newEntry.website.websiteOrigin === access.website.websiteOrigin)?.removed !== true)
	return withEntriesRemoved.map((entry) => changes.find((change) => change.newEntry.website.websiteOrigin === entry.website.websiteOrigin)?.newEntry ?? entry)
}
