import * as funtypes from 'funtypes'
import { isPlainUrlHostname, isWildcardUrlHostname } from '../utils/chromeMatchPatterns.js'

export const DEFAULT_SAFE_APPS_HOST_ORIGINS: readonly string[] = []
export const SAFE_APPS_HOST_ORIGIN_LIMIT = 32

export function parseSafeAppsHostOrigin(value: string) {
	let url: URL
	try {
		url = new URL(value)
	} catch {
		throw new Error('Enter a valid HTTP or HTTPS website URL.')
	}
	if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username !== '' || url.password !== '') throw new Error('Safe Apps hosting requires an HTTP or HTTPS URL without credentials.')
	if (isWildcardUrlHostname(url.hostname)) throw new Error('Choose one website; wildcard hosts are not supported.')
	if (!isPlainUrlHostname(url.hostname)) throw new Error('Enter a plain website host name without special or percent-encoded characters.')
	return url.origin
}

export const SafeAppsHostOrigin = funtypes.String.withConstraint((value) => {
	try { return parseSafeAppsHostOrigin(value) === value } catch { return false }
})

export const SafeAppsHostOrigins = funtypes.ReadonlyArray(SafeAppsHostOrigin).withConstraint((origins) => origins.length <= SAFE_APPS_HOST_ORIGIN_LIMIT && new Set(origins).size === origins.length)

const StoredSafeAppsHostOriginsItem = funtypes.ReadonlyPartial({ safeAppsHostOrigins: funtypes.ReadonlyArray(funtypes.Unknown) })

// Settings reads and content-script registration share this so a stored list with stale invalid entries (e.g. Chrome's '%2A' wildcard) keeps its valid origins; undefined means the stored value is not a list.
export function recoverStoredSafeAppsHostOrigins(storedItems: unknown): readonly string[] | undefined {
	const stored = StoredSafeAppsHostOriginsItem.safeParse(storedItems)
	if (!stored.success) return undefined
	const validOrigins = (stored.value.safeAppsHostOrigins ?? DEFAULT_SAFE_APPS_HOST_ORIGINS).filter((origin): origin is string => SafeAppsHostOrigin.test(origin))
	return [...new Set(validOrigins)].slice(0, SAFE_APPS_HOST_ORIGIN_LIMIT)
}
