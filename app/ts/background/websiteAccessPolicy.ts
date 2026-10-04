import type { AddressBookEntry } from '../types/addressBookTypes.js'
import type { WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import { isLegacyWebsiteOriginForCanonicalOrigin } from '../utils/websiteOrigin.js'

export type ApprovalState = 'hasAccess' | 'noAccess' | 'askAccess' | 'interceptorDisabled'

function getExactAndLegacyWebsiteAccess(websiteAccess: WebsiteAccessArray, websiteOrigin: string) {
	const exactAccess = websiteAccess.find((entry) => entry.website.websiteOrigin === websiteOrigin)
	const legacyAccessEntries = websiteAccess.filter((entry) => isLegacyWebsiteOriginForCanonicalOrigin(entry.website.websiteOrigin, websiteOrigin))
	return { exactAccess, legacyAccessEntries }
}

export function hasAccess(websiteAccess: WebsiteAccessArray, websiteOrigin: string) : ApprovalState {
	const { exactAccess, legacyAccessEntries } = getExactAndLegacyWebsiteAccess(websiteAccess, websiteOrigin)
	if (exactAccess?.interceptorDisabled === true || legacyAccessEntries.some((entry) => entry.interceptorDisabled === true)) return 'interceptorDisabled'
	// Only an exact, scheme-bound record can grant access. Legacy approval remains pending until the user explicitly rebinds it.
	if (exactAccess?.access === true) return 'hasAccess'
	// Legacy grants are scheme-ambiguous, but applying a legacy denial to both schemes cannot expose an account that the user did not authorize.
	if (exactAccess?.access === false || legacyAccessEntries.some((entry) => entry.access === false)) return 'noAccess'
	return 'askAccess'
}

export function hasAddressAccess(websiteAccess: WebsiteAccessArray, websiteOrigin: string, address: AddressBookEntry) : ApprovalState {
	const { exactAccess, legacyAccessEntries } = getExactAndLegacyWebsiteAccess(websiteAccess, websiteOrigin)
	if (exactAccess?.interceptorDisabled === true || legacyAccessEntries.some((entry) => entry.interceptorDisabled === true)) return 'interceptorDisabled'
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
