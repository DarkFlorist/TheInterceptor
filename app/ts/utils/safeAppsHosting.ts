import { SafeAppsHostOrigins } from '../types/safeAppsHosting.js'
import { getChromeMatchPatterns } from './chromeMatchPatterns.js'

export function getSafeAppsHostMatchPatterns(origins: readonly string[]) {
	return SafeAppsHostOrigins.parse(origins).flatMap((origin) => getChromeMatchPatterns(origin, 'exact-origin'))
}
