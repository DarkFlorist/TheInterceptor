import { ContentScriptHostingSettings } from '../types/contentScriptSettings.js'
import { recoverStoredSafeAppsHostOrigins } from '../types/safeAppsHosting.js'
import { getSafeAppsHostMatchPatterns } from '../utils/safeAppsHosting.js'
import { INPAGE_SCRIPTS } from '../config/injectedScripts.js'
import type { FixedContentScript } from './contentScriptDefinition.js'

// [isolated content listener, MAIN-world provider]
export type BaseContentScripts = readonly [FixedContentScript, FixedContentScript]

// undefined: no website is hosted, so the base scripts are the whole registration. An error: the stored hosting settings are unusable, so only the base scripts are registered and the failure is reported.
export type SafeAppsHostingPlan = { readonly origins: readonly string[], readonly scripts: readonly FixedContentScript[] } | { readonly error: Error } | undefined

// The registrations that host Safe Apps on the selected origins: the host runs before the provider there, and the ordinary provider registration leaves those origins to it.
export function planSafeAppsHosting(storedItems: unknown, [contentListener, provider]: BaseContentScripts): SafeAppsHostingPlan {
	const compatibility = ContentScriptHostingSettings.pick('safeAppsCompatibilityMode').safeParse(storedItems)
	if (!compatibility.success) return { error: new Error(compatibility.message) }
	if (compatibility.value.safeAppsCompatibilityMode !== true) return undefined
	const origins = recoverStoredSafeAppsHostOrigins(storedItems)
	if (origins === undefined) return { error: new Error('Stored Safe Apps host origins are not a list.') }
	const matches = getSafeAppsHostMatchPatterns(origins)
	if (matches.length === 0) return undefined
	const hostScript = {
		id: 'safe-apps-host',
		allFrames: true,
		matches,
		excludeMatches: provider.excludeMatches,
		// Keep provider injection in embedded app frames, but the host itself only changes top-level pages. Chrome runs the host before the provider of the active compatibility mode.
		js: [INPAGE_SCRIPTS.safeAppsHost, ...(provider.js ?? [])],
		runAt: 'document_start',
		world: 'MAIN',
		matchOriginAsFallback: true,
	} satisfies FixedContentScript
	return { origins, scripts: [contentListener, { ...provider, excludeMatches: [...(provider.excludeMatches ?? []), ...matches] }, hostScript] }
}
