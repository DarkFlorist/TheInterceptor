import { replaceElementInReadonlyArray } from '../utils/typed-arrays.js'
import { mergeStoredWebsiteMetadata } from '../utils/websiteIcons.js'
import { findWebsiteAccessEntryForOrigin } from './websiteAccessPolicy.js'
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

export function applyWebsiteAccessDecision(previousWebsiteAccess: WebsiteAccessArray, website: Website, access: boolean, address: bigint | undefined): WebsiteAccessArray {
	const match = findWebsiteAccessEntryForOrigin(previousWebsiteAccess, website.websiteOrigin)
	if (match === undefined) {
		return [...previousWebsiteAccess, {
			website,
			access,
			addressAccess: address === undefined || !access ? undefined : [{ address, access }],
		}]
	}

	const { entry: foundEntry, index: foundEntryIndex } = match
	const mergedWebsiteMetadata = mergeStoredWebsiteMetadata(foundEntry.website, website)
	const websiteData = { ...mergedWebsiteMetadata, websiteOrigin: website.websiteOrigin }
	if (match.kind === 'exact') return applyDecisionToEntry(previousWebsiteAccess, foundEntryIndex, foundEntry, websiteData, access, address)
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
