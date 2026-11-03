import type { WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import { getWebsiteOrigin } from './websiteOrigin.js'

// URL parsing keeps a * in a hostname (also one decoded from %2A) and in a file path, but a match pattern reads *. at a host's start as every subdomain and rejects a * elsewhere in a host, failing the whole registration, and both a match-pattern path and a Firefox glob read * as any text. No exclusion can name such an origin exactly, so it is skipped rather than widened to other sites (#1701).
function getCanonicalWebsiteOrigins(origins: readonly string[]) {
	return [...new Set(origins)].filter((origin) => getWebsiteOrigin(origin) === origin && !origin.includes('*'))
}

const isFileOrigin = (origin: string) => origin.startsWith('file:')

// A file's website origin drops its query (getWebsiteOrigin), so every query of the file shares its disabled setting. Match patterns compare the path and query but not the fragment, so the exact path covers the query-less URL and `?*` covers the rest, without matching sibling files such as wallet.html.other.
function getFileExcludeMatches(fileOrigin: string) {
	return [fileOrigin, `${ fileOrigin }?*`]
}

export function getManifestV3ExcludeMatches(origins: readonly string[]) {
	return getCanonicalWebsiteOrigins(origins).flatMap((origin) => {
		if (isFileOrigin(origin)) return getFileExcludeMatches(origin)
		const url = new URL(origin)
		// An omitted match-pattern port means every port, whereas URL.origin omits only the default port.
		const port = url.port || (url.protocol === 'https:' ? '443' : '80')
		return [`${ url.protocol }//${ url.hostname }:${ port }/*`]
	})
}

// Firefox applies excludeMatches and excludeGlobs independently, so each origin uses whichever names it exactly.
export function getManifestV2ExcludeMatches(origins: readonly string[]) {
	// A file has no port, so Firefox's match patterns name it exactly, while a glob would compare the fragment too.
	return getCanonicalWebsiteOrigins(origins).filter(isFileOrigin).flatMap(getFileExcludeMatches)
}

export function getManifestV2ExcludeGlobs(origins: readonly string[]) {
	// Firefox's match patterns do not match explicit ports. Globs compare the URL text, preserving the origin's port boundary.
	return getCanonicalWebsiteOrigins(origins).filter((origin) => !isFileOrigin(origin)).map((origin) => `${ origin }/*`)
}

export const getInterceptorDisabledSites = (websiteAccess: WebsiteAccessArray) => websiteAccess.filter((entry) => entry.interceptorDisabled === true).map((entry) => entry.website.websiteOrigin)
