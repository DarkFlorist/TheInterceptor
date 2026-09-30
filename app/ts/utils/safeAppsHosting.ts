import * as funtypes from 'funtypes'

export const DEFAULT_SAFE_APPS_HOST_ORIGINS = ['https://app.request.finance']

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

export const SafeAppsHostOrigins = funtypes.ReadonlyArray(funtypes.String.withConstraint((value) => {
	try { return parseSafeAppsHostOrigin(value) === value } catch { return false }
})).withConstraint((origins) => origins.length <= 32 && new Set(origins).size === origins.length)

export function getSafeAppsHostMatchPatterns(origins: readonly string[]) {
	return SafeAppsHostOrigins.parse(origins).map((origin) => {
		const url = new URL(origin)
		// An omitted port is a wildcard in Chrome match patterns; specify the default port too.
		return `${ url.protocol }//${ url.hostname }:${ url.port || (url.protocol === 'https:' ? '443' : '80') }/*`
	})
}
