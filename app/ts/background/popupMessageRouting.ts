import { PopupMessage, type Settings } from '../types/interceptor-messages.js'
import { PopupReplyOption } from '../types/interceptor-reply-messages.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { SimulationServicesOwner } from '../simulation/serviceLifecycle.js'
import { METAMASK_ERROR_FAILED_TO_PARSE_REQUEST } from '../utils/constants.js'
import { isExpectedInfrastructureError } from '../utils/errors.js'
import type { PublishRpcConnectionStatus } from './rpcSlowRequestTracking.js'
import { dispatchPopupMessage } from './popupMessageDispatcher.js'
import { getConfirmTransactionAbortController } from './confirmTransactionSimulation.js'
import { resetSimulationStateFromConfig } from './activeSettings.js'
import type { RpcConfigurationState } from './storageVariables.js'
import { RPC_CONFIGURATION_UNAVAILABLE_ERROR } from './rpcConfigurationLifecycle.js'
import { restoreDefaultRpcConfiguration, retryRpcConfiguration, settingsOpened } from './popupMessageHandlers/settings.js'
import { publishRpcConfigurationRecovery } from './activeSettings.js'
import { openNewTab } from './popupMessageHandlers.js'

const simulationAbortController = new AbortController()

export async function popupMessageHandler(
	websiteTabConnections: WebsiteTabConnections,
	simulationServicesOwner: SimulationServicesOwner,
	request: unknown,
	settings: Settings | undefined,
	rpcConfiguration: RpcConfigurationState,
	publishRpcConnectionStatus: PublishRpcConnectionStatus,
) {
	const maybeParsedRequest = PopupMessage.safeParse(request)
	if (maybeParsedRequest.success === false) {
		console.warn({ request })
		console.warn(maybeParsedRequest.fullError)
		return {
			error: {
				message: maybeParsedRequest.fullError === undefined ? 'Unknown parsing error' : maybeParsedRequest.fullError.toString(),
				code: METAMASK_ERROR_FAILED_TO_PARSE_REQUEST,
			}
		}
	}
	if (settings === undefined) {
		switch (maybeParsedRequest.value.method) {
			case 'popup_requestSettings': return await settingsOpened(simulationServicesOwner)
			case 'popup_retryRpcConfiguration': return await retryRpcConfiguration(simulationServicesOwner)
			case 'popup_restoreDefaultRpcConfiguration': return await restoreDefaultRpcConfiguration(simulationServicesOwner, websiteTabConnections, undefined, publishRpcConfigurationRecovery)
			case 'popup_openSettings': return await openNewTab('settingsView')
			default: return { error: RPC_CONFIGURATION_UNAVAILABLE_ERROR }
		}
	}
	try {
		const requestReply = await dispatchPopupMessage({
			websiteTabConnections,
			simulationServicesOwner,
			settings,
			rpcConfiguration,
			publishRpcConnectionStatus,
			simulationAbortController,
			confirmTransactionAbortController: getConfirmTransactionAbortController(),
			resetSimulationState: async () => await resetSimulationStateFromConfig(simulationServicesOwner),
		}, maybeParsedRequest.value)
		if (requestReply === undefined) return undefined
		return PopupReplyOption.serialize(requestReply)
	} catch(error: unknown) {
		if (isExpectedInfrastructureError(error)) return
		throw error
	}
}
