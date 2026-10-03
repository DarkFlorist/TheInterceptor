const WEBSITE_ORIGIN_HASH_KEY = 'origin'
const LEGACY_WEBSITE_ORIGIN_HASH_PREFIX = `#${ WEBSITE_ORIGIN_HASH_KEY }:`
const WEBSITE_ROUTE_PREFIX = '#websites?'

export function getWebsiteOriginFromHash(hash: string): string | undefined {
	if (hash.startsWith(WEBSITE_ROUTE_PREFIX)) return new URLSearchParams(hash.slice(WEBSITE_ROUTE_PREFIX.length)).get(WEBSITE_ORIGIN_HASH_KEY) || undefined
	if (!hash.startsWith(LEGACY_WEBSITE_ORIGIN_HASH_PREFIX)) return undefined
	return hash.slice(LEGACY_WEBSITE_ORIGIN_HASH_PREFIX.length) || undefined
}

export function getWebsiteOriginHash(origin: string): string {
	return `${ WEBSITE_ROUTE_PREFIX }${ new URLSearchParams({ [WEBSITE_ORIGIN_HASH_KEY]: origin }).toString() }`
}

export const WEBSITE_ORIGIN_RADIO_NAME = WEBSITE_ORIGIN_HASH_KEY
