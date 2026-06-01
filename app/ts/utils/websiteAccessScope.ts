import type { WebsiteAccessArray } from '../types/websiteAccessTypes.js'
import { getHostnameForWebsiteOrigin } from './websiteOrigins.js'

type HostScopedFieldOverrides = {
	readonly interceptorDisabled?: boolean
	readonly declarativeNetRequestBlockMode?: 'block-all' | 'disabled'
}

type HostScopedState = {
	interceptorDisabled?: boolean
	declarativeNetRequestBlockMode?: 'block-all' | 'disabled'
}

function getInitialHostScopedState(websiteAccess: WebsiteAccessArray) {
	const hostScopedState = new Map<string, HostScopedState>()
	for (const access of websiteAccess) {
		const hostname = getHostnameForWebsiteOrigin(access.website.websiteOrigin)
		const previous = hostScopedState.get(hostname)
		hostScopedState.set(hostname, {
			interceptorDisabled:
				previous?.interceptorDisabled === true ||
				access.interceptorDisabled === true
					? true
					: previous?.interceptorDisabled,
			declarativeNetRequestBlockMode:
				previous?.declarativeNetRequestBlockMode === 'block-all' ||
				access.declarativeNetRequestBlockMode === 'block-all'
					? 'block-all'
					: previous?.declarativeNetRequestBlockMode,
		})
	}
	return hostScopedState
}

export function normalizeHostnameScopedWebsiteAccess(
	websiteAccess: WebsiteAccessArray,
	hostScopedOverrides: ReadonlyMap<
		string,
		HostScopedFieldOverrides
	> = new Map(),
) {
	const hostScopedState = getInitialHostScopedState(websiteAccess)
	for (const [hostname, overrides] of hostScopedOverrides.entries()) {
		hostScopedState.set(hostname, {
			interceptorDisabled:
				overrides.interceptorDisabled ??
				hostScopedState.get(hostname)?.interceptorDisabled,
			declarativeNetRequestBlockMode:
				overrides.declarativeNetRequestBlockMode ??
				hostScopedState.get(hostname)?.declarativeNetRequestBlockMode,
		})
	}

	let changed = false
	const normalizedWebsiteAccess = websiteAccess.map((access) => {
		const hostname = getHostnameForWebsiteOrigin(access.website.websiteOrigin)
		const hostState = hostScopedState.get(hostname)
		if (hostState === undefined) return access

		const nextInterceptorDisabled =
			hostState.interceptorDisabled ?? access.interceptorDisabled
		const nextDeclarativeNetRequestBlockMode =
			hostState.declarativeNetRequestBlockMode ??
			access.declarativeNetRequestBlockMode
		if (
			nextInterceptorDisabled === access.interceptorDisabled &&
			nextDeclarativeNetRequestBlockMode ===
				access.declarativeNetRequestBlockMode
		)
			return access
		changed = true
		return {
			...access,
			...(nextInterceptorDisabled !== undefined
				? { interceptorDisabled: nextInterceptorDisabled }
				: {}),
			...(nextDeclarativeNetRequestBlockMode !== undefined
				? { declarativeNetRequestBlockMode: nextDeclarativeNetRequestBlockMode }
				: {}),
		}
	})

	return { changed, websiteAccess: normalizedWebsiteAccess }
}
