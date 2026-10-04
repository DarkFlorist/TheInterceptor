import type { WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import { getHostWithPort, getWebsiteOrigin } from './requests.js'

const isCanonicalWebsiteProtocol = (protocol: string) => {
	return protocol === 'http:' || protocol === 'https:' || protocol === 'file:'
}

function normalizeCanonicalWebsiteOrigin(websiteOrigin: string): string | undefined {
	try {
		const url = new URL(websiteOrigin)
		if (!isCanonicalWebsiteProtocol(url.protocol)) return undefined
		if (url.username !== '' || url.password !== '') return undefined
		return getWebsiteOrigin(websiteOrigin)
	} catch {
		return undefined
	}
}

function normalizeLegacyWebsiteOrigin(websiteOrigin: string): string | undefined {
	// Older releases represented every file URL as an empty origin. Retain that marker so it can be rebound to one exact file path after explicit approval.
	if (websiteOrigin === '') return websiteOrigin
	try {
		const legacyUrl = new URL(`https://${ websiteOrigin }`)
		if (legacyUrl.username !== '' || legacyUrl.password !== '') return undefined
		if (legacyUrl.pathname !== '/' || legacyUrl.search !== '' || legacyUrl.hash !== '') return undefined
		const closingIpv6Bracket = websiteOrigin.startsWith('[') ? websiteOrigin.indexOf(']') : -1
		const portSeparator = closingIpv6Bracket === -1 ? websiteOrigin.lastIndexOf(':') : closingIpv6Bracket + 1
		const explicitPort = portSeparator === -1 ? undefined : websiteOrigin.slice(portSeparator + 1)
		return explicitPort === undefined || explicitPort === ''
			? legacyUrl.hostname
			: `${ legacyUrl.hostname }:${ explicitPort }`
	} catch {
		return undefined
	}
}

export function normalizeStoredWebsiteOrigin(websiteOrigin: string): string | undefined {
	if (/^(?:file|https?):\/\//iu.test(websiteOrigin)) return normalizeCanonicalWebsiteOrigin(websiteOrigin)
	return normalizeLegacyWebsiteOrigin(websiteOrigin)
}

export function isCanonicalWebsiteOrigin(websiteOrigin: string): boolean {
	return normalizeCanonicalWebsiteOrigin(websiteOrigin) === websiteOrigin
}

// Legacy records omitted the scheme, so they are only candidates for restrictive decisions or explicit user rebinding, never automatic grants.
export function isLegacyWebsiteOriginForCanonicalOrigin(storedOrigin: string, websiteOrigin: string): boolean {
	const canonicalOrigin = normalizeCanonicalWebsiteOrigin(websiteOrigin)
	if (canonicalOrigin === undefined) return false
	const url = new URL(canonicalOrigin)
	if (url.protocol === 'file:') return storedOrigin === ''
	const legacyHost = getHostWithPort(canonicalOrigin)
	if (storedOrigin === legacyHost) return true
	// Imported legacy data can retain an explicit default port. Keep it discoverable without guessing whether its original scheme was HTTP or HTTPS.
	const defaultPort = url.protocol === 'https:' ? '443' : '80'
	return url.port === '' && storedOrigin === `${ legacyHost }:${ defaultPort }`
}

export function getWebsiteHostWithPortFromStoredOrigin(websiteOrigin: string): string | undefined {
	const normalizedOrigin = normalizeStoredWebsiteOrigin(websiteOrigin)
	if (normalizedOrigin === undefined || normalizedOrigin === '') return undefined
	if (!isCanonicalWebsiteOrigin(normalizedOrigin)) return normalizedOrigin
	const url = new URL(normalizedOrigin)
	if (url.protocol === 'file:') return undefined
	return getHostWithPort(normalizedOrigin)
}

export function normalizeWebsiteAccessOrigins(websiteAccess: WebsiteAccessArray): WebsiteAccessArray {
	let changed = false
	const normalized = websiteAccess.flatMap((entry) => {
		const websiteOrigin = normalizeStoredWebsiteOrigin(entry.website.websiteOrigin)
		if (websiteOrigin === undefined) {
			changed = true
			return []
		}
		if (websiteOrigin === entry.website.websiteOrigin) return [entry]
		changed = true
		return [{ ...entry, website: { ...entry.website, websiteOrigin } }]
	})
	return changed ? normalized : websiteAccess
}
