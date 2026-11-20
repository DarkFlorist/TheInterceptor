export const getHostWithPort = (urlString: string): string => {
	const url = new URL(urlString)
	return url.port ? `${ url.hostname }:${ url.port }` : url.hostname
}

export const getWebsiteOrigin = (urlString: string): string => {
	const url = new URL(urlString)
	if (url.origin !== 'null') return url.origin
	if (url.protocol === 'file:') return `file://${ url.host }${ url.pathname }`
	return url.href
}

// `getHostWithPort` with the scheme of the URL in front, such as `https://example.com:8443`, so the host and port are normalized in one place. Unlike `URL.origin`, URLs without a tuple origin do not all collapse to the same 'null', so two different origins never compare equal.
export const getSchemeAndHostWithPort = (urlString: string): string => `${ new URL(urlString).protocol }//${ getHostWithPort(urlString) }`

// Both origins of a requesting frame, derived from its URL in one place: `websiteOrigin` is the canonical origin that website access settings are keyed by, and `requestOrigin` is the frame's scheme, host and port that sign-in messages are compared with.
export const getFrameOrigins = (frameUrl: string) => ({ websiteOrigin: getWebsiteOrigin(frameUrl), requestOrigin: getSchemeAndHostWithPort(frameUrl) })

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
	// Imported bare file:// records used to disable every file page, like the empty legacy marker. Do not turn them into authority for the root path.
	if (/^file:\/\/$/iu.test(websiteOrigin)) return ''
	if (/^(?:file|https?):\/\//iu.test(websiteOrigin)) return normalizeCanonicalWebsiteOrigin(websiteOrigin)
	return normalizeLegacyWebsiteOrigin(websiteOrigin)
}

export function isCanonicalWebsiteOrigin(websiteOrigin: string): boolean {
	return normalizeCanonicalWebsiteOrigin(websiteOrigin) === websiteOrigin
}

// Interpret canonical and legacy stored identities once. Consumers choose hostname-only matching or port-sensitive matching without re-parsing or guessing a legacy scheme.
export function getStoredWebsiteHost(storedOrigin: string): { readonly hostname: string, readonly hostWithPort: string } | undefined {
	const normalized = normalizeStoredWebsiteOrigin(storedOrigin)
	if (normalized === undefined || normalized === '') return undefined
	const canonical = isCanonicalWebsiteOrigin(normalized)
	const url = new URL(canonical ? normalized : `https://${ normalized }`)
	if (url.protocol === 'file:') return undefined
	// A legacy explicit default port must survive: its original scheme is unknown, unlike a canonical origin's scheme-default port.
	return { hostname: url.hostname, hostWithPort: canonical ? getHostWithPort(normalized) : normalized }
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

// Whether a stored website access record stands for a canonical origin: the origin's exact record, or a scheme-ambiguous legacy record for it. The access policy, request blocking and content-script injection all decide whether a record covers a page through this one rule, so they agree on what is the same site.
export function doesStoredWebsiteOriginApplyTo(storedOrigin: string, websiteOrigin: string): boolean {
	return storedOrigin === websiteOrigin || isLegacyWebsiteOriginForCanonicalOrigin(storedOrigin, websiteOrigin)
}
