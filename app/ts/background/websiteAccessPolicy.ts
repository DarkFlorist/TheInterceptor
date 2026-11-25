import type { SettingsSnapshot, WebsiteApprovalsSnapshot } from './settings.js'
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

// The access a website has for the active address, or for the website itself when no address is active. Connection approval and request blocking both decide by it.
export const getWebsiteAccessForAddress = (websiteAccess: WebsiteAccessArray, websiteOrigin: string, activeAddress: AddressBookEntry | undefined) => activeAddress ? hasAddressAccess(websiteAccess, websiteOrigin, activeAddress) : hasAccess(websiteAccess, websiteOrigin)

// For a best-effort display, unreadable approvals supply no entries. Decisions that must abort on a failed read use requireReadableApprovals.
export function approvalsOrNoneIfUnreadable(snapshot: SettingsSnapshot | WebsiteApprovalsSnapshot): WebsiteAccessArray {
	if (snapshot.status === 'active-network-readable') return snapshot.settings.websiteAccess
	const websiteApprovals = snapshot.status === 'active-network-unreadable' ? snapshot.websiteApprovals : snapshot
	return websiteApprovals.status === 'readable' ? websiteApprovals.websiteAccess : []
}

// Projection for paths where a failed read must stop the caller (for example so applied request blocks stay in place): rethrows the storage error.
export function requireReadableApprovals(websiteApprovals: WebsiteApprovalsSnapshot): WebsiteAccessArray {
	if (websiteApprovals.status === 'unreadable') throw websiteApprovals.error
	return websiteApprovals.websiteAccess
}
