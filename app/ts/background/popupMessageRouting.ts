import { PopupMessage, type Settings } from '../types/interceptor-messages.js'
import { PopupReplyOption } from '../types/interceptor-reply-messages.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { SimulationServicesOwner } from '../simulation/serviceLifecycle.js'
import { METAMASK_ERROR_FAILED_TO_PARSE_REQUEST } from '../utils/constants.js'
import type { PublishRpcConnectionStatus } from './rpcSlowRequestTracking.js'
import { dispatchPopupMessage } from './popupMessageDispatcher.js'
import { getConfirmTransactionAbortController } from './confirmTransactionSimulation.js'
import { resetSimulationStateFromConfig } from './activeSettings.js'
import { readFailedRpcConfiguration, type RpcConfigurationState } from './rpcConfigurationStorage.js'
import { getSettingsSnapshot, settingsIfAvailable, type SettingsSnapshot } from './settings.js'
import { isExpectedInfrastructureError, reportUnexpectedError } from '../utils/errors.js'

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

// The admission read never rejects: a rejected settings read (for example a failed repair write of a corrupt field) is reported and admitted as an unreadable RPC configuration. Recovery-class requests (Settings, Retry and Restore) therefore still run and publish the unreadable status, and every request that needs settings is refused exactly as it is for an unreadable configuration.
async function getSettingsSnapshotForAdmission(): Promise<SettingsSnapshot> {
	try {
		return await getSettingsSnapshot()
	} catch (error: unknown) {
		await reportUnexpectedError(error)
		return { status: 'unavailable', rpcConfiguration: readFailedRpcConfiguration(error), websiteApprovals: { status: 'unreadable', error } }
	}
}

// The background's entry point for popup runtime messages.
export async function handlePopupRuntimeMessage(
	websiteTabConnections: WebsiteTabConnections,
	simulationServicesOwner: SimulationServicesOwner,
	message: unknown,
	publishRpcConnectionStatus: PublishRpcConnectionStatus,
) {
	const settingsSnapshot = await getSettingsSnapshotForAdmission()
	return await popupMessageHandler(websiteTabConnections, simulationServicesOwner, message, settingsIfAvailable(settingsSnapshot), settingsSnapshot.rpcConfiguration, publishRpcConnectionStatus)
}
