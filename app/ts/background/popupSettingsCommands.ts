import { createPopupSettingsCoordinator } from './popupSettingsCoordinator.js'
import { sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { popupSettingsOperations, type PopupSettingsAdmittedRequest } from '../types/popupSettingsProtocol.js'
import type { PopupMessage } from '../types/interceptor-messages.js'
import type { PopupReplyOption } from '../types/interceptor-reply-messages.js'
import { popupMessageHandler, type PopupMessageDispatcherContext, type PopupMessageHandlerMap } from './popupMessageHandlerRegistry.js'
import { getSettings } from './settings.js'
import { changeActiveAddress, enableSimulationMode, importSettingsAndRefresh, modifyMakeMeRich, modifyRichToken, popupChangeActiveRpc, setNewRpcList } from './popupMessageHandlers.js'
import { isPopupSimulationAvailable, runPopupSimulationRefresh } from './popupSimulationRefreshQueue.js'
import { completeRichFundingMutation, toModifyRichTokenReply, toRichSettingsChangeReply } from './richFundingReplies.js'
import { validateRichFundingChain } from './richFundingContext.js'
import { getPopupVisualisationState } from './storageVariables.js'

const settingsCoordinator = createPopupSettingsCoordinator(async (data) => await sendPopupMessageToOpenWindows({ method: 'popup_settingsChangeStatus', data }))

function settingsCommand<Method extends PopupSettingsAdmittedRequest['method']>(method: Method, action: (context: PopupMessageDispatcherContext, request: Extract<PopupMessage, { method: Method }>) => Promise<PopupReplyOption | void>) {
	return popupMessageHandler(method, async (context, request) => {
		const descriptor = popupSettingsOperations[method]
		const admission = await settingsCoordinator.run(descriptor.operation, async () => await action({ ...context, settings: await getSettings() }, request))
		if (admission.accepted) return admission.result
		const message = 'Another popup is changing settings. Please wait for it to finish, then try again.'
		const reply = descriptor.reply
		if (reply.transport === 'broadcast') {
			await sendPopupMessageToOpenWindows(reply.createFailure(message))
			return
		}
		if ('createFailure' in reply) return reply.createFailure(message)
		return { type: reply.type, ok: false, message }
	})
}

// The protocol descriptor is the exhaustive operation/reply source; this boundary owns admission and command completion.
export const popupSettingsCommandHandlers = {
	popup_requestSettingsChangeStatus: popupMessageHandler('popup_requestSettingsChangeStatus', async () => await settingsCoordinator.publish()),
	popup_set_rpc_list: settingsCommand('popup_set_rpc_list', async (context, request) => {
		await setNewRpcList(context.simulationServicesOwner, context.websiteTabConnections, request)
		return { type: 'PopupSettingsChangeReply', ok: true }
	}),
	popup_import_settings: settingsCommand('popup_import_settings', async (context, request) => await importSettingsAndRefresh(context.simulationServicesOwner, context.websiteTabConnections, request)),
	popup_changeActiveAddress: settingsCommand('popup_changeActiveAddress', async (context, request) => await changeActiveAddress(context.simulationServicesOwner, context.websiteTabConnections, request)),
	popup_changeActiveRpc: settingsCommand('popup_changeActiveRpc', async (context, request) => await popupChangeActiveRpc(context.simulationServicesOwner, context.websiteTabConnections, request)),
	popup_enableSimulationMode: settingsCommand('popup_enableSimulationMode', async (context, request) => {
		await enableSimulationMode(context.simulationServicesOwner, context.websiteTabConnections, request)
		return { type: 'PopupSettingsChangeReply', ok: true }
	}),
	popup_modifyRichToken: settingsCommand('popup_modifyRichToken', async (context, request) => {
		const services = context.simulationServicesOwner.getCurrent()
		const result = validateRichFundingChain(context.settings, services.ethereum, request.data.chainId) ?? await modifyRichToken(services.ethereum, context.simulationAbortController, request)
		return toModifyRichTokenReply(await completeRichFundingMutation(result, {
			refresh: async () => await runPopupSimulationRefresh({ ...services, invalidateOldState: true }),
			isStoredSimulationAvailable: async () => isPopupSimulationAvailable(await getPopupVisualisationState()),
		}))
	}),
	popup_modifyMakeMeRich: settingsCommand('popup_modifyMakeMeRich', async (context, request) => {
		const services = context.simulationServicesOwner.getCurrent()
		const result = validateRichFundingChain(context.settings, services.ethereum, request.data.action === 'set-native-amount' ? request.data.chainId : undefined) ?? await modifyMakeMeRich(request)
		return toRichSettingsChangeReply(await completeRichFundingMutation(result, {
			refresh: async () => await runPopupSimulationRefresh({ ...services, invalidateOldState: true }),
			isStoredSimulationAvailable: async () => isPopupSimulationAvailable(await getPopupVisualisationState()),
		}))
	}),
} satisfies Pick<PopupMessageHandlerMap, PopupSettingsAdmittedRequest['method'] | 'popup_requestSettingsChangeStatus'>
