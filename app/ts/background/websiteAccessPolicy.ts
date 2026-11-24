import type { AddressBookEntry } from '../types/addressBookTypes.js'
import type { WebsiteAccess, WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import { doesStoredWebsiteOriginApplyTo, isLegacyWebsiteOriginForCanonicalOrigin, isStorableWebsiteOrigin } from '../utils/websiteOrigin.js'

export type ApprovalState = 'hasAccess' | 'noAccess' | 'askAccess' | 'interceptorDisabled'

export function getWebsiteAccessAuthorityForOrigin(websiteAccess: WebsiteAccessArray, websiteOrigin: string) {
	const match = findWebsiteAccessEntryForOrigin(websiteAccess, websiteOrigin)
	const exactAccess = match?.kind === 'exact' ? match.entry : undefined
	const legacyDenials = getLegacyWebsiteDenials(websiteAccess.filter((entry) => isLegacyWebsiteOriginForCanonicalOrigin(entry.website.websiteOrigin, websiteOrigin)))
	return { exactAccess, legacyDenials }
}

// Everything scheme-ambiguous legacy records decide for an origin: whether they deny the website and which addresses they deny. They are read only through legacyWebsiteRestrictions, so they can never grant, and the access checks consult them only through this summary.
function getLegacyWebsiteDenials(legacyEntries: readonly WebsiteAccess[]) {
	const restrictions = legacyEntries.map(legacyWebsiteRestrictions)
	const deniedAddresses = new Set(restrictions.flatMap((entry) => entry.addressAccess?.filter((address) => !address.access).map((address) => address.address) ?? []))
	return {
		deniesWebsite: restrictions.some((entry) => entry.access === false),
		deniesAddress: (address: bigint) => deniedAddresses.has(address),
	}
}

// Scheme-ambiguous records carry only restrictions until explicit consent rebinds them. Policy reads and consent mutations share this projection so legacy grants cannot leak through either path.
export function legacyWebsiteRestrictions(entry: WebsiteAccess): WebsiteAccess {
	const denials = entry.addressAccess?.filter((address) => !address.access)
	return { ...entry, access: entry.access === false ? false : undefined, addressAccess: denials?.length === 0 ? undefined : denials }
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

// A frame without a website access key, such as about:blank, about:srcdoc or a data: page, is refused outright: no record could be stored for it, so asking would reopen the consent dialog after every approval.
export function hasAccess(websiteAccess: WebsiteAccessArray, websiteOrigin: string) : ApprovalState {
	if (!isStorableWebsiteOrigin(websiteOrigin)) return 'noAccess'
	const { exactAccess, legacyDenials } = getWebsiteAccessAuthorityForOrigin(websiteAccess, websiteOrigin)
	if (isInterceptorDisabledForWebsiteOrigin(websiteAccess, websiteOrigin)) return 'interceptorDisabled'
	// Only an exact, scheme-bound record can grant access. Legacy approval remains pending until the user explicitly rebinds it.
	if (exactAccess?.access === true) return 'hasAccess'
	// Legacy grants are scheme-ambiguous, but applying a legacy denial to both schemes cannot expose an account that the user did not authorize.
	if (exactAccess?.access === false || legacyDenials.deniesWebsite) return 'noAccess'
	return 'askAccess'
}

export function hasAddressAccess(websiteAccess: WebsiteAccessArray, websiteOrigin: string, address: AddressBookEntry) : ApprovalState {
	if (!isStorableWebsiteOrigin(websiteOrigin)) return 'noAccess'
	const { exactAccess, legacyDenials } = getWebsiteAccessAuthorityForOrigin(websiteAccess, websiteOrigin)
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
		// The exact grant overrides a legacy website denial, but a legacy address denial still applies to that address.
		if (legacyDenials.deniesAddress(address.address)) return 'noAccess'
		if (address.askForAddressAccess === false) return 'hasAccess'
		return 'askAccess'
	}
	if (legacyDenials.deniesWebsite || legacyDenials.deniesAddress(address.address)) return 'noAccess'
	return 'askAccess'
}
