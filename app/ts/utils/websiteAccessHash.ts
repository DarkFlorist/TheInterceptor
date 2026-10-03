const WEBSITE_ORIGIN_HASH_KEY = 'origin'
const WEBSITE_ORIGIN_HASH_PREFIX = `#${ WEBSITE_ORIGIN_HASH_KEY }:`

export function getWebsiteOriginFromHash(hash: string): string | undefined {
	if (!hash.startsWith(WEBSITE_ORIGIN_HASH_PREFIX)) return undefined
	return hash.slice(WEBSITE_ORIGIN_HASH_PREFIX.length) || undefined
}

export function getWebsiteOriginHash(origin: string): string {
	return `${ WEBSITE_ORIGIN_HASH_PREFIX }${ origin }`
}

export function isWebsiteOriginHash(hash: string): boolean {
	return getWebsiteOriginFromHash(hash) !== undefined
}

export const WEBSITE_ORIGIN_RADIO_NAME = WEBSITE_ORIGIN_HASH_KEY
