import { getManagementPageHash, getManagementPageParameters } from './managementPages.js'

const WEBSITE_ORIGIN_HASH_KEY = 'origin'
export const WEBSITE_ORIGIN_RADIO_NAME = WEBSITE_ORIGIN_HASH_KEY

export function getWebsiteListHash() {
	return getManagementPageHash('websites')
}

export function getWebsiteOriginFromHash(hash: string): string | undefined {
	return getManagementPageParameters(hash, 'websites')?.get(WEBSITE_ORIGIN_HASH_KEY) || undefined
}

export function getWebsiteOriginHash(origin: string): string {
	return `${ getWebsiteListHash() }?${ new URLSearchParams({ [WEBSITE_ORIGIN_HASH_KEY]: origin }).toString() }`
}
