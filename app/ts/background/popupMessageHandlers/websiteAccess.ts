import type { SimulationServicesOwner } from '../simulationServicesOwner.js'
import type { AllowOrPreventAddressAccessForWebsite, BlockOrAllowExternalRequests, DisableInterceptor, RemoveWebsiteAccess, RemoveWebsiteAddressAccess, RetrieveWebsiteAccess } from '../../types/interceptor-messages.js'
import { applyWebsiteAccessUpdate } from '../applyWebsiteAccessUpdate.js'
import { withInterceptorDisabledForWebsite, withExternalRequestsBlockedOrAllowed, withoutAddressAccess, withAddressAccessForWebsite, withoutWebsiteAccess } from '../websiteAccessMutations.js'
import { sendPopupMessageToOpenWindows } from '../backgroundUtils.js'
import { getSettings } from '../settings.js'
import type { WebsiteTabConnections } from '../../types/user-interface-types.js'
import { getAddressMetadataForAccess } from '../windows/interceptorAccess.js'
import { searchWebsiteAccess } from '../websiteAccessSearch.js'

export async function disableInterceptor(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, parsedRequest: DisableInterceptor) {
	await applyWebsiteAccessUpdate(simulationServicesOwner, websiteTabConnections, 'alsoWhenInjectionUnchanged', withInterceptorDisabledForWebsite(parsedRequest.data.website, parsedRequest.data.interceptorDisabled))
	await sendPopupMessageToOpenWindows({ method: 'popup_setDisableInterceptorReply' as const, data: parsedRequest.data })
}

export async function retrieveWebsiteAccess(parsedRequest: RetrieveWebsiteAccess) {
	const settings = await getSettings()
	const websiteAccess = searchWebsiteAccess(parsedRequest.data.query, settings.websiteAccess)
	const addressAccessMetadata = await getAddressMetadataForAccess(websiteAccess, settings.activeRpcNetwork.chainId)
	await sendPopupMessageToOpenWindows({ method: 'popup_retrieveWebsiteAccessReply', data: { websiteAccess, addressAccessMetadata } })
}

export async function blockOrAllowExternalRequests(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, parsedRequest: BlockOrAllowExternalRequests) {
	await applyWebsiteAccessUpdate(simulationServicesOwner, websiteTabConnections, 'alsoWhenInjectionUnchanged', withExternalRequestsBlockedOrAllowed(parsedRequest.data.website, parsedRequest.data.shouldBlock))
	await sendPopupMessageToOpenWindows({ method: 'popup_websiteAccess_changed' })
}

export async function removeWebsiteAddressAccess(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, parsedRequest: RemoveWebsiteAddressAccess) {
	await applyWebsiteAccessUpdate(simulationServicesOwner, websiteTabConnections, 'alsoWhenInjectionUnchanged', withoutAddressAccess(parsedRequest.data.websiteOrigin, parsedRequest.data.address))
	await sendPopupMessageToOpenWindows({ method: 'popup_websiteAccess_changed' })
}

export async function allowOrPreventAddressAccessForWebsite(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, parsedRequest: AllowOrPreventAddressAccessForWebsite) {
	const { website, address, allowAccess } = parsedRequest.data
	await applyWebsiteAccessUpdate(simulationServicesOwner, websiteTabConnections, 'alsoWhenInjectionUnchanged', withAddressAccessForWebsite(website.websiteOrigin, address, allowAccess))
	await sendPopupMessageToOpenWindows({ method: 'popup_websiteAccess_changed' })
}

export async function removeWebsiteAccess(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, parsedRequest: RemoveWebsiteAccess) {
	await applyWebsiteAccessUpdate(simulationServicesOwner, websiteTabConnections, 'whenInjectionChanges', withoutWebsiteAccess(parsedRequest.data.websiteOrigin))
	await sendPopupMessageToOpenWindows({ method: 'popup_websiteAccess_changed' })
}
