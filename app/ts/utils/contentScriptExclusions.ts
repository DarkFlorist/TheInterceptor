import type { WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import { getWebsiteOrigin } from './websiteOrigin.js'

// URL parsing keeps a * in a hostname (also one decoded from %2A) and in a file path, but a match pattern reads *. at a host's start as every subdomain and rejects a * elsewhere in a host, failing the whole registration, and both a match-pattern path and a Firefox glob read * as any text. No exclusion can name such an origin exactly, so it is skipped rather than widened to other sites (#1701).
function getCanonicalWebsiteOrigins(origins: readonly string[]) {
	return [...new Set(origins)].filter((origin) => getWebsiteOrigin(origin) === origin && !origin.includes('*'))
}

export function getManifestV3ExcludeMatches(origins: readonly string[]) {
	return getCanonicalWebsiteOrigins(origins).map((origin) => {
		const url = new URL(origin)
		if (url.protocol === 'file:') return url.href
		// An omitted match-pattern port means every port, whereas URL.origin omits only the default port.
		const port = url.port || (url.protocol === 'https:' ? '443' : '80')
		return `${ url.protocol }//${ url.hostname }:${ port }/*`
	})
}

export function getManifestV2ExcludeGlobs(origins: readonly string[]) {
	// Firefox's match patterns do not match explicit ports. Globs compare the URL text, preserving the origin's port boundary.
	return getCanonicalWebsiteOrigins(origins).map((origin) => origin.startsWith('file:') ? origin : `${ origin }/*`)
}


export const getInterceptorDisabledSites = (websiteAccess: WebsiteAccessArray) => websiteAccess.filter((entry) => entry.interceptorDisabled === true).map((entry) => entry.website.websiteOrigin)
