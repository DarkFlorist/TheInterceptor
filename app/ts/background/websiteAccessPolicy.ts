import type { AddressBookEntry } from '../types/addressBookTypes.js'
import type { WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import { doesStoredWebsiteOriginApplyTo, isLegacyWebsiteOriginForCanonicalOrigin } from '../utils/websiteOrigin.js'

export type ApprovalState = 'hasAccess' | 'noAccess' | 'askAccess' | 'interceptorDisabled'

function getExactAndLegacyWebsiteAccess(websiteAccess: WebsiteAccessArray, websiteOrigin: string) {
	const match = findWebsiteAccessEntryForOrigin(websiteAccess, websiteOrigin)
	const exactAccess = match?.kind === 'exact' ? match.entry : undefined
	const legacyAccessEntries = websiteAccess.filter((entry) => isLegacyWebsiteOriginForCanonicalOrigin(entry.website.websiteOrigin, websiteOrigin))
	return { exactAccess, legacyAccessEntries }
}

// Lookup preserves whether the details belong to this exact origin or require explicit legacy rebinding; only exact records can grant access.
export function findWebsiteAccessEntryForOrigin(websiteAccess: WebsiteAccessArray, websiteOrigin: string) {
	const exactIndex = websiteAccess.findIndex((entry) => entry.website.websiteOrigin === websiteOrigin)
	const exact = websiteAccess[exactIndex]
	if (exact !== undefined) return { kind: 'exact' as const, entry: exact, index: exactIndex }
	const legacyIndex = websiteAccess.findIndex((entry) => isLegacyWebsiteOriginForCanonicalOrigin(entry.website.websiteOrigin, websiteOrigin))
	const legacy = websiteAccess[legacyIndex]
	return legacy === undefined ? undefined : { kind: 'legacy' as const, entry: legacy, index: legacyIndex }
}

// The Interceptor stays disabled for an origin while any exact or scheme-ambiguous legacy record for it is disabled, matching content-script injection, which excludes the origin of every disabled record.
export function isInterceptorDisabledForWebsiteOrigin(websiteAccess: WebsiteAccessArray, websiteOrigin: string) {
	return websiteAccess.some((entry) => entry.interceptorDisabled === true
		&& doesStoredWebsiteOriginApplyTo(entry.website.websiteOrigin, websiteOrigin))
}

export function hasAccess(websiteAccess: WebsiteAccessArray, websiteOrigin: string) : ApprovalState {
	const { exactAccess, legacyAccessEntries } = getExactAndLegacyWebsiteAccess(websiteAccess, websiteOrigin)
	if (isInterceptorDisabledForWebsiteOrigin(websiteAccess, websiteOrigin)) return 'interceptorDisabled'
	// Only an exact, scheme-bound record can grant access. Legacy approval remains pending until the user explicitly rebinds it.
	if (exactAccess?.access === true) return 'hasAccess'
	// Legacy grants are scheme-ambiguous, but applying a legacy denial to both schemes cannot expose an account that the user did not authorize.
	if (exactAccess?.access === false || legacyAccessEntries.some((entry) => entry.access === false)) return 'noAccess'
	return 'askAccess'
}

export function hasAddressAccess(websiteAccess: WebsiteAccessArray, websiteOrigin: string, address: AddressBookEntry) : ApprovalState {
	const { exactAccess, legacyAccessEntries } = getExactAndLegacyWebsiteAccess(websiteAccess, websiteOrigin)
	if (isInterceptorDisabledForWebsiteOrigin(websiteAccess, websiteOrigin)) return 'interceptorDisabled'
	if (exactAccess?.access === false) return 'noAccess'
	if (exactAccess?.access === true) {
		if (exactAccess.addressAccess !== undefined) {
			for (const addressAccess of exactAccess.addressAccess) {
				if (addressAccess.address === address.address) {
					return addressAccess.access ? 'hasAccess' : 'noAccess'
				}
			}
		}
		if (legacyAccessEntries.some((legacy) => legacy.addressAccess?.some((entry) => entry.address === address.address && entry.access === false) === true)) return 'noAccess'
		if (address.askForAddressAccess === false) return 'hasAccess'
		return 'askAccess'
	}
	if (legacyAccessEntries.some((entry) => entry.access === false)) return 'noAccess'
	if (legacyAccessEntries.some((legacy) => legacy.addressAccess?.some((entry) => entry.address === address.address && entry.access === false) === true)) return 'noAccess'
	return 'askAccess'
}
