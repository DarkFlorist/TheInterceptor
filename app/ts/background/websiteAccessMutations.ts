import { replaceElementInReadonlyArray } from '../utils/typed-arrays.js'
import { mergeStoredWebsiteMetadata } from '../utils/websiteIcons.js'
import { findWebsiteAccessEntryForOrigin, legacyWebsiteRestrictions } from './websiteAccessPolicy.js'
import type { Website, WebsiteAccess, WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import type { EthereumAddress } from '../types/wire-types.js'
import { modifyObject } from '../utils/typescript.js'
import { getCanonicalOriginsOfLegacyWebsiteOrigin, isLegacyWebsiteOriginForCanonicalOrigin } from '../utils/websiteOrigin.js'

// Pure changes to website-access data live here. The handler-level workflow in applyWebsiteAccessUpdate.ts owns persistence, injection refresh, reloads and approval reconciliation.
export type WebsiteAccessMutation = (previousWebsiteAccess: WebsiteAccessArray) => WebsiteAccessArray

// Disabling or re-enabling the Interceptor changes only the page's own origin. Disabling adds or updates its exact record and leaves legacy disables in place, so the other scheme they alias stays disabled. Re-enabling must clear a legacy disable that covers the page, since any disabled record covering a page disables it, but a legacy record covers more than this origin. A host-only record is therefore rebound: it is cleared and each other origin it covered, such as the other scheme of the host, gets an exact disabled record, so only the page the user re-enabled changes. The empty legacy file marker stands for every file page, which no set of exact records can name, so re-enabling one file page leaves it in place and that page stays disabled until the user re-enables file pages through a record the action fully covers.
export const withInterceptorDisabledForWebsite = (website: Website, interceptorDisabled: boolean): WebsiteAccessMutation => (previousWebsiteAccess) => {
	const otherOriginsToKeepDisabled = new Set<string>()
	const withPageUpdated = previousWebsiteAccess.map((entry) => {
		if (entry.website.websiteOrigin === website.websiteOrigin) return { ...entry, interceptorDisabled }
		if (interceptorDisabled || entry.interceptorDisabled !== true || !isLegacyWebsiteOriginForCanonicalOrigin(entry.website.websiteOrigin, website.websiteOrigin)) return entry
		const coveredOrigins = getCanonicalOriginsOfLegacyWebsiteOrigin(entry.website.websiteOrigin)
		if (coveredOrigins === undefined) return entry
		for (const origin of coveredOrigins) {
			if (origin !== website.websiteOrigin) otherOriginsToKeepDisabled.add(origin)
		}
		return { ...entry, interceptorDisabled: false }
	})
	const withOtherOriginsDisabled = withPageUpdated.map((entry) => otherOriginsToKeepDisabled.has(entry.website.websiteOrigin) ? { ...entry, interceptorDisabled: true } : entry)
	const existingOrigins = new Set(previousWebsiteAccess.map((entry) => entry.website.websiteOrigin))
	const newRecords = [
		...existingOrigins.has(website.websiteOrigin) ? [] : [{ website, addressAccess: [], interceptorDisabled }],
		...[...otherOriginsToKeepDisabled].filter((origin) => !existingOrigins.has(origin)).map((websiteOrigin) => ({ website: { websiteOrigin, icon: undefined, title: undefined }, addressAccess: [], interceptorDisabled: true })),
	]
	return [...withOtherOriginsDisabled, ...newRecords]
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
	const reboundEntry = legacyWebsiteRestrictions(foundEntry)
	const legacyDenials = reboundEntry.addressAccess ?? []
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
