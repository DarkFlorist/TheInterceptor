import type { InterceptedRequest } from '../utils/requests.js'
import type { Settings } from '../types/interceptor-messages.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { isAccountConnectionMethod, isAccountOnlyMethod } from './accountRequestMethods.js'
import { verifyAccess } from './accessManagement.js'
import { hasAddressAccess } from './websiteAccessPolicy.js'
import type { AddressedRequestAccessContext, RequestAccessContext } from './requestAccessContext.js'

type AccessVerificationIntent = { readonly kind: 'initial' } | { readonly kind: 'reroute', readonly previouslyVerified: AddressedRequestAccessContext }

// One policy governs initial admission and mode rerouting. A reroute cannot prompt or carry a connection grant onto another address; an ordinary unchanged address reuses its completed admission without repeating connection notifications. Native-source contexts always require the live stored address grant.
export function verifyRequestAccess(connections: WebsiteTabConnections, request: InterceptedRequest, context: RequestAccessContext, settings: Settings, intent: AccessVerificationIntent) {
	const { activeAddress, accessSocket, accessOrigin, requireAddressAccess } = context
	if (requireAddressAccess) {
		if (activeAddress === undefined) return 'noAccess'
		// Borrowed host authority is already connected. Revalidate consent without publishing connection events or prompting.
		const access = hasAddressAccess(settings.websiteAccess, accessOrigin, activeAddress)
		return access === 'askAccess' ? 'noAccess' : access
	}
	if (intent.kind === 'reroute' && !requireAddressAccess && activeAddress?.address === intent.previouslyVerified.activeAddress.address) return 'hasAccess'
	const interactive = intent.kind === 'initial'
	return verifyAccess(connections, accessSocket, interactive && (isAccountConnectionMethod(request.method) || request.method === 'eth_call' || request.method === 'eth_simulateV1'), accessOrigin, activeAddress, settings, {
		ignoreConnectionApproval: isAccountOnlyMethod(request.method) || !interactive,
	})
}
