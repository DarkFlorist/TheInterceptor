import { retrieveWebsiteDetails } from './iconHandler.js'
import { isTopFrameId } from './signerExecutionAuthority.js'
import { getTabState } from './storageVariables.js'

export async function getWebsiteDetailsForConnection(tabId: number, websiteOrigin: string, frameId: number | undefined) {
	if (isTopFrameId(frameId)) return await retrieveWebsiteDetails(tabId, websiteOrigin)
	const tabState = await getTabState(tabId)
	if (tabState.website?.websiteOrigin !== websiteOrigin) return { title: undefined, icon: undefined }
	return { title: tabState.website.title, icon: tabState.website.icon }
}
