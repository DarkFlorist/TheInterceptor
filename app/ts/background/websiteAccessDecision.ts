import type { Website, WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import { replaceElementInReadonlyArray } from '../utils/typed-arrays.js'
import { modifyObject } from '../utils/typescript.js'
import { mergeStoredWebsiteMetadata } from '../utils/websiteIcons.js'
import { isLegacyWebsiteOriginForCanonicalOrigin } from '../utils/websiteOrigin.js'

export function isInterceptorDisabledForWebsiteOrigin(websiteAccess: WebsiteAccessArray, websiteOrigin: string): boolean {
	return websiteAccess.some((entry) => {
		if (entry.interceptorDisabled !== true) return false
		return entry.website.websiteOrigin === websiteOrigin || isLegacyWebsiteOriginForCanonicalOrigin(entry.website.websiteOrigin, websiteOrigin)
	})
}

export function applyInterceptorDisabledDecision(previousWebsiteAccess: WebsiteAccessArray, website: Website, interceptorDisabled: boolean): WebsiteAccessArray {
	let foundExactEntry = false
	const updatedWebsiteAccess = previousWebsiteAccess.map((entry) => {
		if (entry.website.websiteOrigin === website.websiteOrigin) {
			foundExactEntry = true
			return { ...entry, interceptorDisabled }
		}
		if (isLegacyWebsiteOriginForCanonicalOrigin(entry.website.websiteOrigin, website.websiteOrigin) && entry.interceptorDisabled === true) {
			return { ...entry, interceptorDisabled: false }
		}
		return entry
	})
	if (foundExactEntry) return updatedWebsiteAccess
	return [...updatedWebsiteAccess, { website, addressAccess: [], interceptorDisabled }]
}

export function applyWebsiteAccessDecision(previousWebsiteAccess: WebsiteAccessArray, website: Website, access: boolean, address: bigint | undefined): WebsiteAccessArray {
	const exactEntryIndex = previousWebsiteAccess.findIndex((entry) => entry.website.websiteOrigin === website.websiteOrigin)
	const legacyEntryIndex = previousWebsiteAccess.findIndex((entry) => isLegacyWebsiteOriginForCanonicalOrigin(entry.website.websiteOrigin, website.websiteOrigin))
	const foundEntryIndex = exactEntryIndex !== -1 ? exactEntryIndex : legacyEntryIndex
	const foundEntry = previousWebsiteAccess[foundEntryIndex]
	if (foundEntry === undefined) {
		return [...previousWebsiteAccess, {
			website,
			access,
			addressAccess: address === undefined || !access ? undefined : [{ address, access }],
		}]
	}

	const mergedWebsiteMetadata = mergeStoredWebsiteMetadata(foundEntry.website, website)
	const websiteData = { ...mergedWebsiteMetadata, websiteOrigin: website.websiteOrigin }
	if (exactEntryIndex === -1 && access === false) {
		// A denial identifies the exact origin but does not authorize carrying scheme-ambiguous legacy grants into that origin.
		const restrictiveAddressAccess = foundEntry.addressAccess?.filter((entry) => entry.access === false) ?? []
		const nextAddressAccess = address === undefined
			? restrictiveAddressAccess
			: [
				...restrictiveAddressAccess.filter((entry) => entry.address !== address),
				{ address, access: false },
			]
		return replaceElementInReadonlyArray(previousWebsiteAccess, foundEntryIndex, {
			...foundEntry,
			website: websiteData,
			access: false,
			addressAccess: nextAddressAccess.length === 0 ? undefined : nextAddressAccess,
		})
	}
	if (address === undefined) {
		return replaceElementInReadonlyArray(previousWebsiteAccess, foundEntryIndex, modifyObject(foundEntry, { website: websiteData, access }))
	}

	const addressAccess = { address, access }
	const updatedEntry = modifyObject(foundEntry, { website: websiteData, access: foundEntry.access ? foundEntry.access : access })
	if (foundEntry.addressAccess === undefined) {
		return replaceElementInReadonlyArray(previousWebsiteAccess, foundEntryIndex, modifyObject(updatedEntry, { addressAccess: [addressAccess] }))
	}
	if (foundEntry.addressAccess.find((entry) => entry.address === address) === undefined) {
		return replaceElementInReadonlyArray(previousWebsiteAccess, foundEntryIndex, modifyObject(updatedEntry, { addressAccess: [...foundEntry.addressAccess, addressAccess] }))
	}
	return replaceElementInReadonlyArray(previousWebsiteAccess, foundEntryIndex, modifyObject(updatedEntry, {
		addressAccess: foundEntry.addressAccess.map((entry) => entry.address === address ? addressAccess : entry)
	}))
}
