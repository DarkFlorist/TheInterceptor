import type { SimulationServicesOwner } from '../simulation/serviceLifecycle.js'
import type { PendingAccessRequest } from '../types/accessRequest.js'
import type { InterceptorAccessReply } from '../types/interceptor-messages.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { activateAddressSelection } from './activeSettings.js'
import { createInterceptedRequestReplay } from './background.js'
import type { PublishRpcConnectionStatus } from './rpcSlowRequestTracking.js'
import { getSettings } from './settings.js'
import { getTabState } from './storageVariables.js'
import { persistWebsiteAccessChange, syncWebsiteApprovalsWithSettings } from './websiteAccessReconciliation.js'
import { getAllowedAddressSelectionForAccessRequest, settleInterceptorAccessReply } from './windows/interceptorAccess.js'

// Resolves a reply from the access dialog. It sits above the dialog because answering can change settings, prompt for further accesses, and replay the waiting requests through the RPC router.

async function applyAccessReply(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, accessReply: InterceptorAccessReply, pendingAccessRequest: PendingAccessRequest, userRequestedAddressChange: boolean) {
	const persistAccessReply = async () => await persistWebsiteAccessChange(
		websiteTabConnections,
		pendingAccessRequest.website,
		accessReply.userReply === 'Approved',
		accessReply.requestAccessToAddress,
		false,
	)
	const approvedAddressSelection = accessReply.userReply === 'Approved' && accessReply.requestAccessToAddress !== undefined
		? await getAllowedAddressSelectionForAccessRequest(pendingAccessRequest, accessReply.requestAccessToAddress, 'pendingEntry')
		: undefined
	if (!userRequestedAddressChange) {
		await persistAccessReply()
		return
	}
	if (accessReply.requestAccessToAddress === undefined) throw new Error('Changed request to page level')
	await persistAccessReply()
	const settings = await getSettings()
	const signerAddress = (await getTabState(pendingAccessRequest.socket.tabId)).signerAccounts[0]
	const selection = approvedAddressSelection ?? await getAllowedAddressSelectionForAccessRequest(pendingAccessRequest, accessReply.requestAccessToAddress, 'pendingEntry')
	await activateAddressSelection(simulationServicesOwner, websiteTabConnections, selection, {
		simulationMode: settings.simulationMode,
		signerAddress,
		promptForAccessesIfNeeded: false,
	})
}

export async function resolveInterceptorAccess(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, reply: InterceptorAccessReply, publishRpcConnectionStatus: PublishRpcConnectionStatus) {
	const settlement = await settleInterceptorAccessReply(websiteTabConnections, reply, async (accessReply, pendingAccessRequest, userRequestedAddressChange) => {
		await applyAccessReply(simulationServicesOwner, websiteTabConnections, accessReply, pendingAccessRequest, userRequestedAddressChange)
	})
	if (settlement.promptForFollowUpAccesses) await syncWebsiteApprovalsWithSettings(websiteTabConnections, { promptForAccessesIfNeeded: true })
	await settlement.replayAnsweredRequests(createInterceptedRequestReplay(simulationServicesOwner, websiteTabConnections, publishRpcConnectionStatus))
}
