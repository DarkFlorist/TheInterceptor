import { sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { createPopupSettingsCoordinator } from './popupSettingsCoordinator.js'
import { popupSettingsOperations } from '../types/popupSettingsProtocol.js'
import type { PopupSettingsRequest } from '../types/popupSettingsRequests.js'
import type { PopupMessage } from '../types/interceptor-messages.js'
import type { PopupReplyOption } from '../types/interceptor-reply-messages.js'
import { popupMessageHandler, type PopupMessageDispatcherContext, type PopupMessageHandlerMap } from './popupMessageHandlerRegistry.js'
import { getSettings } from './settings.js'
import { changeActiveAddress, enableSimulationMode, modifyMakeMeRich, popupChangeActiveRpc } from './popupMessageHandlers.js'
import { queuePopupSimulationRefresh } from './popupSimulationRefreshQueue.js'

const settingsCoordinator = createPopupSettingsCoordinator(async (data) => await sendPopupMessageToOpenWindows({ method: 'popup_settingsChangeStatus', data }))

function settingsCommand<Method extends PopupSettingsRequest['method']>(method: Method, action: (context: PopupMessageDispatcherContext, request: Extract<PopupMessage, { method: Method }>) => Promise<PopupReplyOption | void>) {
	return popupMessageHandler(method, async (context, request) => {
		const descriptor = popupSettingsOperations[method]
		const admission = await settingsCoordinator.run(descriptor.operation, async () => await action({ ...context, settings: await getSettings() }, request))
		return admission.accepted ? admission.result : {
			type: descriptor.replyType,
			ok: false,
			message: 'Another popup is changing settings. Please wait for it to finish, then try again.',
		}
	})
}

// The protocol descriptor is the exhaustive operation/reply source; this boundary owns admission and command completion.
export const popupSettingsCommandHandlers = {
	popup_requestSettingsChangeStatus: popupMessageHandler('popup_requestSettingsChangeStatus', async () => await settingsCoordinator.publish()),
	popup_changeActiveAddress: settingsCommand('popup_changeActiveAddress', async (context, request) => await changeActiveAddress(context.ethereum, context.tokenPriceService, context.resetSimulationServices, context.websiteTabConnections, request)),
	popup_changeActiveRpc: settingsCommand('popup_changeActiveRpc', async (context, request) => await popupChangeActiveRpc(context.ethereum, context.tokenPriceService, context.resetSimulationServices, context.websiteTabConnections, request, context.settings)),
	popup_enableSimulationMode: settingsCommand('popup_enableSimulationMode', async (context, request) => {
		await enableSimulationMode(context.ethereum, context.tokenPriceService, context.resetSimulationServices, context.websiteTabConnections, request)
		return { type: 'PopupSettingsChangeReply', ok: true }
	}),
	popup_modifyMakeMeRich: settingsCommand('popup_modifyMakeMeRich', async (context, request) => {
		if (await modifyMakeMeRich(request)) {
			const outcome = await queuePopupSimulationRefresh({ ethereum: context.ethereum, tokenPriceService: context.tokenPriceService, invalidateOldState: true })
			if (outcome.status === 'observed' && !outcome.available) {
				return { type: 'PopupSettingsChangeReply', ok: false, message: 'The rich setting was saved, but the latest simulation is unavailable. Please refresh the simulation to retry.' }
			}
		}
		return { type: 'PopupSettingsChangeReply', ok: true }
	}),
} satisfies Pick<PopupMessageHandlerMap, PopupSettingsRequest['method'] | 'popup_requestSettingsChangeStatus'>
