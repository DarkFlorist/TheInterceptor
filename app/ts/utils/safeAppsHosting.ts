import { SafeAppsHostOrigins } from '../types/safeAppsHosting.js'

export function getSafeAppsHostMatchPatterns(origins: readonly string[]) {
	return SafeAppsHostOrigins.parse(origins).map((origin) => {
		const url = new URL(origin)
		// An omitted port is a wildcard in Chrome match patterns; specify the default port too.
		return `${ url.protocol }//${ url.hostname }:${ url.port || (url.protocol === 'https:' ? '443' : '80') }/*`
	})
}
