import * as funtypes from 'funtypes'

export const DEFAULT_SAFE_APPS_HOST_ORIGINS: readonly string[] = []

export function parseSafeAppsHostOrigin(value: string) {
	let url: URL
	try {
		url = new URL(value)
	} catch {
		throw new Error('Enter a valid HTTP or HTTPS website URL.')
	}
	if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username !== '' || url.password !== '') throw new Error('Safe Apps hosting requires an HTTP or HTTPS URL without credentials.')
	if (url.hostname.includes('*')) throw new Error('Choose one website; wildcard hosts are not supported.')
	return url.origin
}

export const SafeAppsHostOrigin = funtypes.String.withConstraint((value) => {
	try { return parseSafeAppsHostOrigin(value) === value } catch { return false }
})

export const SafeAppsHostOrigins = funtypes.ReadonlyArray(SafeAppsHostOrigin).withConstraint((origins) => origins.length <= 32 && new Set(origins).size === origins.length)
