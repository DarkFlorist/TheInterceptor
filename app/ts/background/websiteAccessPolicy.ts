import type { AddressBookEntry } from '../types/addressBookTypes.js'
import type { WebsiteAccessArray } from '../types/websiteAccessTypes.js'

export type ApprovalState = 'hasAccess' | 'noAccess' | 'askAccess' | 'interceptorDisabled'

export function hasAccess(websiteAccess: WebsiteAccessArray, websiteOrigin: string): ApprovalState {
	for (const web of websiteAccess) {
		if (web.website.websiteOrigin !== websiteOrigin) continue
		if (web.interceptorDisabled) return 'interceptorDisabled'
		if (web.access === true) return 'hasAccess'
		if (web.access === false) return 'noAccess'
		return 'askAccess'
	}
	return 'askAccess'
}

export function hasAddressAccess(websiteAccess: WebsiteAccessArray, websiteOrigin: string, address: AddressBookEntry): ApprovalState {
	for (const web of websiteAccess) {
		if (web.website.websiteOrigin !== websiteOrigin) continue
		if (web.interceptorDisabled) return 'interceptorDisabled'
		if (web.access === false) return 'noAccess'
		if (web.access !== true) return 'askAccess'
		for (const addressAccess of web.addressAccess ?? []) {
			if (addressAccess.address === address.address) return addressAccess.access ? 'hasAccess' : 'noAccess'
		}
		return address.askForAddressAccess === false ? 'hasAccess' : 'askAccess'
	}
	return 'askAccess'
}
