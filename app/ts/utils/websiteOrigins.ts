import { tryOrUndefined } from './try.js'

const IPV4_HOST_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}$/

type ParsedWebsiteOrigin = {
	readonly hostname: string
	readonly port: string
}

// Stored websiteOrigin values are host[:port] fragments, so we attach a
// temporary scheme to reuse URL parsing instead of treating them as full URLs.
function parseWebsiteOrigin(origin: string): ParsedWebsiteOrigin | undefined {
	return tryOrUndefined(
		() => {
			const url = new URL(`https://${origin}`)
			return {
				hostname: url.hostname,
				port: url.port,
			}
		},
		(error) => error instanceof TypeError,
	)
}

export function getHostnameForWebsiteOrigin(origin: string) {
	return parseWebsiteOrigin(origin)?.hostname ?? origin
}

export function isHostScopedWebsiteOrigin(origin: string) {
	const parsed = parseWebsiteOrigin(origin)
	return parsed !== undefined && parsed.port === ''
}

function isIpHostname(hostname: string) {
	return IPV4_HOST_PATTERN.test(hostname) || hostname.startsWith('[') || hostname.includes(':')
}

function canMatchSubdomains(hostname: string) {
	return hostname !== 'localhost' && hostname.includes('.') && !isIpHostname(hostname)
}

export function doWebsiteOriginsShareHostname(leftOrigin: string, rightOrigin: string) {
	return getHostnameForWebsiteOrigin(leftOrigin) === getHostnameForWebsiteOrigin(rightOrigin)
}

export function getDomainMatchPatternsForHostname(hostname: string) {
	if (hostname === '') return []
	if (!canMatchSubdomains(hostname)) return [`*://${hostname}/*`]
	return [`*://${hostname}/*`, `*://*.${hostname}/*`]
}

export function getDomainMatchPatterns(origin: string) {
	return getDomainMatchPatternsForHostname(getHostnameForWebsiteOrigin(origin))
}
