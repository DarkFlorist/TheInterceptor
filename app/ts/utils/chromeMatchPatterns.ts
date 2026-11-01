// URL parsers disagree on unusual host characters (Chrome percent-encodes '*' as '%2A' while Bun and Firefox keep '*'), so accept only hosts every parser leaves unescaped (lowercase [a-z0-9_-] labels, which cover IPv4 and punycode, or bracketed IPv6) and wildcards and other encoded characters never reach match patterns or stored settings.
const PLAIN_DNS_OR_IPV4_HOSTNAME = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.?$/
const BRACKETED_IPV6_HOSTNAME = /^\[[0-9a-f:.]+\]$/
const WILDCARD_HOSTNAME = /\*|%2a/i

export const isPlainUrlHostname = (hostname: string) => PLAIN_DNS_OR_IPV4_HOSTNAME.test(hostname) || BRACKETED_IPV6_HOSTNAME.test(hostname)
export const isWildcardUrlHostname = (hostname: string) => WILDCARD_HOSTNAME.test(hostname)

// Disabled sites include subdomains and unspecified ports; hosting selects exactly one scheme, host and effective port.
export function getChromeMatchPatterns(value: string, intent: 'exact-origin' | 'site-with-subdomains') {
	if (value === '') return intent === 'site-with-subdomains' ? ['file:///*'] : []
	const hasExplicitScheme = value.includes('://')
	if (intent === 'exact-origin' && !hasExplicitScheme) return []
	let url: URL
	try { url = new URL(hasExplicitScheme ? value : `http://${ value }`) } catch { return [] }
	if (url.protocol === 'file:') return intent === 'site-with-subdomains' && url.hostname === '' ? ['file:///*'] : []
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return []
	if (url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '' || !isPlainUrlHostname(url.hostname)) return []
	const isIpAddressOrLocalhost = url.hostname === 'localhost' || url.hostname.startsWith('[') || /^\d+(?:\.\d+){3}$/.test(url.hostname)
	const hostname = intent === 'site-with-subdomains' && !isIpAddressOrLocalhost ? `*.${ url.hostname }` : url.hostname
	// URL.port already removes explicit scheme-default ports (WHATWG URL port state). Chrome treats an omitted port as a wildcard, so an exact origin must specify even its default port.
	const port = intent === 'exact-origin' ? url.port || (url.protocol === 'https:' ? '443' : '80') : url.port
	const host = port === '' ? hostname : `${ hostname }:${ port }`
	const schemes = hasExplicitScheme ? [url.protocol] : url.port === '' ? ['*:'] : ['http:', 'https:']
	return schemes.map((scheme) => `${ scheme }//${ host }/*`)
}


export function getChromeSiteMatchPatterns(origins: readonly string[]) {
	return [...new Set(origins.flatMap((origin) => getChromeMatchPatterns(origin, 'site-with-subdomains')))]
}
