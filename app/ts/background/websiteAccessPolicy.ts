import type { AddressBookEntry } from '../types/addressBookTypes.js'
import type { WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import { getLegacyWebsiteOriginForCanonicalOrigin } from './websiteAccessMigration.js'

export type ApprovalState = 'hasAccess' | 'noAccess' | 'askAccess' | 'interceptorDisabled'

function getExactAndLegacyWebsiteAccess(websiteAccess: WebsiteAccessArray, websiteOrigin: string) {
	const exactAccess = websiteAccess.find((entry) => entry.website.websiteOrigin === websiteOrigin)
	const legacyWebsiteOrigin = getLegacyWebsiteOriginForCanonicalOrigin(websiteOrigin)
	const legacyAccess = legacyWebsiteOrigin === undefined
		? undefined
		: websiteAccess.find((entry) => entry.website.websiteOrigin === legacyWebsiteOrigin)
	return { exactAccess, legacyAccess }
}

export function hasAccess(websiteAccess: WebsiteAccessArray, websiteOrigin: string) : ApprovalState {
	const { exactAccess, legacyAccess } = getExactAndLegacyWebsiteAccess(websiteAccess, websiteOrigin)
	if (exactAccess?.interceptorDisabled === true || legacyAccess?.interceptorDisabled === true) return 'interceptorDisabled'
	if (exactAccess?.access === true) return 'hasAccess'
	// Legacy grants are scheme-ambiguous, but applying a legacy denial to both schemes cannot expose an account that the user did not authorize.
	if (exactAccess?.access === false || legacyAccess?.access === false) return 'noAccess'
	return 'askAccess'
}

export function hasAddressAccess(websiteAccess: WebsiteAccessArray, websiteOrigin: string, address: AddressBookEntry) : ApprovalState {
	const { exactAccess, legacyAccess } = getExactAndLegacyWebsiteAccess(websiteAccess, websiteOrigin)
	if (exactAccess?.interceptorDisabled === true || legacyAccess?.interceptorDisabled === true) return 'interceptorDisabled'
	if (exactAccess?.access === false) return 'noAccess'
	if (exactAccess?.access === true) {
		if (exactAccess.addressAccess !== undefined) {
			for (const addressAccess of exactAccess.addressAccess) {
				if (addressAccess.address === address.address) {
					return addressAccess.access ? 'hasAccess' : 'noAccess'
				}
			}
		}
		if (legacyAccess?.addressAccess?.some((entry) => entry.address === address.address && entry.access === false) === true) return 'noAccess'
		if (address.askForAddressAccess === false) return 'hasAccess'
		return 'askAccess'
	}
	if (legacyAccess?.access === false) return 'noAccess'
	if (legacyAccess?.addressAccess?.some((entry) => entry.address === address.address && entry.access === false) === true) return 'noAccess'
	return 'askAccess'
}
