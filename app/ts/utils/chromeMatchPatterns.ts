import { getHostWithPort } from './requests.js'

// URL parsers disagree on unusual host characters (Chrome percent-encodes '*' as '%2A' while Bun and Firefox keep '*'), so accept only hosts every parser leaves unescaped (lowercase [a-z0-9_-] labels, which cover IPv4 and punycode, or bracketed IPv6) and wildcards and other encoded characters never reach match patterns or stored settings.
const PLAIN_DNS_OR_IPV4_HOSTNAME = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.?$/
const BRACKETED_IPV6_HOSTNAME = /^\[[0-9a-f:.]+\]$/
const WILDCARD_HOSTNAME = /\*|%2a/i

export const isPlainUrlHostname = (hostname: string) => PLAIN_DNS_OR_IPV4_HOSTNAME.test(hostname) || BRACKETED_IPV6_HOSTNAME.test(hostname)
export const isWildcardUrlHostname = (hostname: string) => WILDCARD_HOSTNAME.test(hostname)

// A match pattern without a port matches every port of its host, while one with a port compares it with the URL's effective port, so naming the default port too keeps the pattern to that one origin. Chrome rejects a port after the * scheme, so each pattern names its scheme.
const getExactOriginMatchPattern = (url: URL) => `${ url.protocol }//${ url.hostname }:${ url.port || (url.protocol === 'https:' ? '443' : '80') }/*`

// Hosting selects one scheme, host and effective port. A disabled site is stored per getHostWithPort origin and excluded on exactly the URLs with that origin, not its subdomains or other ports (#1701).
export function getChromeMatchPatterns(value: string, intent: 'exact-origin' | 'disabled-site') {
	if (value === '') return intent === 'disabled-site' ? ['file:///*'] : []
	const hasExplicitScheme = value.includes('://')
	if (intent === 'exact-origin' && !hasExplicitScheme) return []
	let url: URL
	try { url = new URL(hasExplicitScheme ? value : `http://${ value }`) } catch { return [] }
	if (url.protocol === 'file:') return intent === 'disabled-site' && url.hostname === '' ? ['file:///*'] : []
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return []
	if (url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '' || !isPlainUrlHostname(url.hostname)) return []
	if (hasExplicitScheme) return [getExactOriginMatchPattern(url)]
	// Keep each scheme whose URLs getHostWithPort maps back to this origin. It leaves out a scheme's default port, so for example a stored port 80 only comes from an https URL.
	return ['http:', 'https:']
		.map((scheme) => new URL(`${ scheme }//${ value }/`))
		.filter((schemeUrl) => getHostWithPort(schemeUrl.href) === value)
		.map(getExactOriginMatchPattern)
}

export function getChromeSiteMatchPatterns(origins: readonly string[]) {
	return [...new Set(origins.flatMap((origin) => getChromeMatchPatterns(origin, 'disabled-site')))]
}
