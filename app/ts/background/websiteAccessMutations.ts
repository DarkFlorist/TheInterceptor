import type { Website, WebsiteAccess, WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import type { EthereumAddress } from '../types/wire-types.js'
import { replaceElementInReadonlyArray } from '../utils/typed-arrays.js'
import { modifyObject } from '../utils/typescript.js'

// Pure changes to website-access data live here. Persistence, injection refresh, reloads and approval reconciliation belong to websiteAccessUpdating.ts.
export type WebsiteAccessMutation = (previousWebsiteAccess: WebsiteAccessArray) => WebsiteAccessArray

export const withInterceptorDisabledForWebsite = (website: Website, interceptorDisabled: boolean): WebsiteAccessMutation => (previousWebsiteAccess) => {
	const index = previousWebsiteAccess.findIndex((entry) => entry.website.websiteOrigin === website.websiteOrigin)
	const previousAccess = index !== -1 ? previousWebsiteAccess[index] : undefined
	if (previousAccess === undefined) return [...previousWebsiteAccess, { website, addressAccess: [], interceptorDisabled }]
	return replaceElementInReadonlyArray(previousWebsiteAccess, index, { ...previousAccess, interceptorDisabled })
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
