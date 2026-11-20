import type { Website, WebsiteAccess, WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import { replaceElementInReadonlyArray } from '../utils/typed-arrays.js'
import { modifyObject } from '../utils/typescript.js'
import { mergeStoredWebsiteMetadata } from '../utils/websiteIcons.js'
import { findWebsiteAccessEntryForOrigin } from './websiteAccessPolicy.js'

export function applyWebsiteAccessDecision(previousWebsiteAccess: WebsiteAccessArray, website: Website, access: boolean, address: bigint | undefined): WebsiteAccessArray {
	const exactEntryIndex = previousWebsiteAccess.findIndex((entry) => entry.website.websiteOrigin === website.websiteOrigin)
	const foundEntry = findWebsiteAccessEntryForOrigin(previousWebsiteAccess, website.websiteOrigin)
	const foundEntryIndex = foundEntry === undefined ? -1 : previousWebsiteAccess.indexOf(foundEntry)
	if (foundEntry === undefined) {
		return [...previousWebsiteAccess, {
			website,
			access,
			addressAccess: address === undefined || !access ? undefined : [{ address, access }],
		}]
	}

	const mergedWebsiteMetadata = mergeStoredWebsiteMetadata(foundEntry.website, website)
	const websiteData = { ...mergedWebsiteMetadata, websiteOrigin: website.websiteOrigin }
	if (exactEntryIndex !== -1) return applyDecisionToEntry(previousWebsiteAccess, exactEntryIndex, foundEntry, websiteData, access, address)
	// Rebinding a scheme-ambiguous legacy record to this exact origin keeps only its denials. Its per-address grants were never shown in this decision's consent dialog, so carrying them over would authorize accounts the user did not approve for this origin; the user approves those accounts again.
	const legacyDenials = foundEntry.addressAccess?.filter((entry) => entry.access === false) ?? []
	const reboundEntry = { ...foundEntry, addressAccess: legacyDenials.length === 0 ? undefined : legacyDenials }
	if (access === false) {
		// A denial identifies the exact origin but does not authorize carrying the legacy page-level grant into that origin either.
		const nextAddressAccess = address === undefined ? legacyDenials : [...legacyDenials.filter((entry) => entry.address !== address), { address, access: false }]
		return replaceElementInReadonlyArray(previousWebsiteAccess, foundEntryIndex, {
			...reboundEntry,
			website: websiteData,
			access: false,
			addressAccess: nextAddressAccess.length === 0 ? undefined : nextAddressAccess,
		})
	}
	return applyDecisionToEntry(previousWebsiteAccess, foundEntryIndex, reboundEntry, websiteData, access, address)
}

// Applies a decision to the record at foundEntryIndex, which is either the origin's exact record or a legacy record already reduced to what may be rebound to the origin.
function applyDecisionToEntry(previousWebsiteAccess: WebsiteAccessArray, foundEntryIndex: number, foundEntry: WebsiteAccess, websiteData: Website, access: boolean, address: bigint | undefined): WebsiteAccessArray {
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
