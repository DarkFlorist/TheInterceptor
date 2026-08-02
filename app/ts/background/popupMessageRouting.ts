import { PopupMessage, type Settings } from '../types/interceptor-messages.js'
import { PopupReplyOption } from '../types/interceptor-reply-messages.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { TokenPriceService } from '../simulation/services/priceEstimator.js'
import type { ResetSimulationServices } from '../simulation/serviceLifecycle.js'
import { METAMASK_ERROR_FAILED_TO_PARSE_REQUEST } from '../utils/constants.js'
import { isExpectedInfrastructureError } from '../utils/errors.js'
import type { PublishRpcConnectionStatus } from './rpcSlowRequestTracking.js'
import { dispatchPopupMessage } from './popupMessageDispatcher.js'
import { getConfirmTransactionAbortController } from './confirmTransactionSimulation.js'
import { resetSimulationStateFromConfig } from './activeSettings.js'

const simulationAbortController = new AbortController()

export async function popupMessageHandler(
	websiteTabConnections: WebsiteTabConnections,
	ethereum: EthereumClientService,
	tokenPriceService: TokenPriceService,
	resetSimulationServices: ResetSimulationServices,
	request: unknown,
	settings: Settings,
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
			ethereum,
			tokenPriceService,
			resetSimulationServices,
			settings,
			publishRpcConnectionStatus,
			simulationAbortController,
			confirmTransactionAbortController: getConfirmTransactionAbortController(),
			resetSimulationState: async () => await resetSimulationStateFromConfig(ethereum, tokenPriceService),
		}, maybeParsedRequest.value)
		if (requestReply === undefined) return undefined
		return PopupReplyOption.serialize(requestReply)
	} catch(error: unknown) {
		if (isExpectedInfrastructureError(error)) return
		throw error
	}
}
