import { sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { createPopupSettingsCoordinator } from './popupSettingsCoordinator.js'
import { popupSettingsOperations } from '../types/popupSettingsProtocol.js'
import type { PopupSettingsRequest } from '../types/popupSettingsRequests.js'
import type { PopupMessage } from '../types/interceptor-messages.js'
import type { PopupReplyOption } from '../types/interceptor-reply-messages.js'
import { admitPopupRequest, popupMessageHandler, type PopupMessageHandlerMap, type PopupReadyAdmissionMethod, type PopupReadyMessageDispatcherContext } from './popupMessageHandlerRegistry.js'
import { getSettingsSnapshot, requireSettings } from './settings.js'
import { changeActiveAddress, enableSimulationMode, modifyMakeMeRich, popupChangeActiveRpc } from './popupMessageHandlers.js'
import { queuePopupSimulationRefresh } from './popupSimulationRefreshQueue.js'
import { getRpcServicesAtAdmission, rpcConfigurationIsReady } from './rpcConfigurationAvailability.js'
import { reportUnexpectedError } from '../utils/errors.js'

const settingsCoordinator = createPopupSettingsCoordinator(async (data) => await sendPopupMessageToOpenWindows({ method: 'popup_settingsChangeStatus', data }))

function settingsCommand<Method extends PopupSettingsRequest['method'] & PopupReadyAdmissionMethod>(method: Method, action: (context: PopupReadyMessageDispatcherContext, request: Extract<PopupMessage, { method: Method }>) => Promise<PopupReplyOption | void>) {
	return popupMessageHandler(method, async (context, request) => {
		const descriptor = popupSettingsOperations[method]
		const admission = await settingsCoordinator.run(descriptor.operation, async () => {
			const snapshot = await getSettingsSnapshot()
			const refreshedContext = { ...context, settings: snapshot.settings, rpcConfiguration: snapshot.rpcConfiguration }
			const refreshedAdmission = admitPopupRequest(refreshedContext, request)
			if (refreshedAdmission.kind === 'rejected') return refreshedAdmission.reply
			return await action({ ...refreshedContext, settings: requireSettings(snapshot) }, request)
		})
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
	popup_changeActiveAddress: settingsCommand('popup_changeActiveAddress', async (context, request) => {
		if (!rpcConfigurationIsReady(context.rpcConfiguration)) throw new Error('Popup RPC configuration admission invariant failed.')
		return await changeActiveAddress(context.simulationServicesOwner, context.websiteTabConnections, request, { settings: context.settings, rpcConfiguration: context.rpcConfiguration })
	}),
	popup_changeActiveRpc: settingsCommand('popup_changeActiveRpc', async (context, request) => await popupChangeActiveRpc(context.simulationServicesOwner, context.websiteTabConnections, request)),
	popup_enableSimulationMode: settingsCommand('popup_enableSimulationMode', async (context, request) => {
		if (!rpcConfigurationIsReady(context.rpcConfiguration)) throw new Error('Popup RPC configuration admission invariant failed.')
		await enableSimulationMode(context.simulationServicesOwner, context.websiteTabConnections, request, {}, { settings: context.settings, rpcConfiguration: context.rpcConfiguration })
		return { type: 'PopupSettingsChangeReply', ok: true }
	}),
	popup_modifyMakeMeRich: settingsCommand('popup_modifyMakeMeRich', async (context, request) => {
		if (await modifyMakeMeRich(request)) {
			const services = getRpcServicesAtAdmission(context.rpcConfiguration, context.simulationServicesOwner)
			if (services !== undefined) {
				try {
					await queuePopupSimulationRefresh({ ...services, invalidateOldState: true })
				} catch (error: unknown) {
					await reportUnexpectedError(error, {
						source: 'make_me_rich_simulation_refresh',
						code: 'make_me_rich_saved_refresh_failed',
						displayMessage: 'The rich setting was saved, but the simulation could not be refreshed. Refresh it to retry.',
						suppressExpectedHandledErrors: false,
					})
				}
			}
		}
		return { type: 'PopupSettingsChangeReply', ok: true }
	}),
} satisfies Pick<PopupMessageHandlerMap, PopupSettingsRequest['method'] | 'popup_requestSettingsChangeStatus'>
