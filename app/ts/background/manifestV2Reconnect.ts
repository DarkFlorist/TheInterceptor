import type { InterceptedRequestForward } from '../types/interceptor-messages.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { type WebsiteSocket, isMissingBrowserTargetError } from '../utils/requests.js'
import { websiteSocketToString } from './backgroundUtils.js'
import { isIgnorablePortLifecycleError } from './contentScriptPortLifecycle.js'
import { EthereumQuantity, serialize } from '../types/wire-types.js'

const waitForReplacementWebsiteConnection = async (websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, previousPort: browser.runtime.Port | undefined) => {
	const identifier = websiteSocketToString(socket)
	const deadline = Date.now() + 1_000
	while (true) {
		const currentPort = websiteTabConnections.get(socket.tabId)?.connections[identifier]?.port
		if (currentPort !== undefined && currentPort !== previousPort) return true
		const remainingTime = deadline - Date.now()
		if (remainingTime <= 0) return false
		await new Promise((resolve) => setTimeout(resolve, Math.min(50, remainingTime)))
	}
}

const requestManifestV2ContentScriptReconnect = async (socket: WebsiteSocket) => {
	try {
		await browser.tabs.sendMessage(socket.tabId, {
			method: 'interceptor_reconnect_content_script_port',
			connectionName: serialize(EthereumQuantity, socket.connectionName),
		})
		return true
	} catch (error: unknown) {
		if (error instanceof Error && isIgnorablePortLifecycleError(error)) return false
		if (isMissingBrowserTargetError(error)) return false
		throw error
	}
}

export async function attemptDeliveryAfterManifestV2Reconnect(websiteTabConnections: WebsiteTabConnections, message: InterceptedRequestForward, attemptDelivery: () => boolean | undefined | Promise<boolean | undefined>) {
	const socket = message.uniqueRequestIdentifier.requestSocket
	const previousPort = websiteTabConnections.get(socket.tabId)?.connections[websiteSocketToString(socket)]?.port
	const delivered = await attemptDelivery()
	if (delivered !== false || browser.runtime.getManifest().manifest_version !== 2 || message.type === 'doNotReply') return delivered
	if (!await requestManifestV2ContentScriptReconnect(socket)) return false
	if (!await waitForReplacementWebsiteConnection(websiteTabConnections, socket, previousPort)) return false
	return await attemptDelivery()
}
