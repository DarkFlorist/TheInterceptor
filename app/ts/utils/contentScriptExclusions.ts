import { getWebsiteOrigin } from './websiteOrigin.js'

function getCanonicalWebsiteOrigins(origins: readonly string[]) {
	return [...new Set(origins)].filter((origin) => getWebsiteOrigin(origin) === origin)
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

