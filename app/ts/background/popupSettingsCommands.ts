import { scheduleAddressBookChangePublication } from './addressBookChangePublication.js'
import { createPopupSettingsCoordinator } from './popupSettingsCoordinator.js'
import { sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { popupSettingsOperations, type PopupSettingsAdmittedRequest } from '../types/popupSettingsProtocol.js'
import type { PopupMessage } from '../types/interceptor-messages.js'
import type { PopupReplyOption } from '../types/interceptor-reply-messages.js'
import { popupMessageHandler, type PopupMessageDispatcherContext, type PopupMessageHandlerMap } from './popupMessageHandlerRegistry.js'
import { getSettings } from './settings.js'
import { changeActiveAddress, enableSimulationMode, importSettingsAndRefresh, modifyMakeMeRich, popupChangeActiveRpc, setNewRpcList } from './popupMessageHandlers.js'
import { runPopupSimulationRefresh } from './popupSimulationRefreshQueue.js'

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
	popup_import_settings: settingsCommand('popup_import_settings', async (context, request) => await importSettingsAndRefresh(context.simulationServicesOwner, context.websiteTabConnections, request, () => scheduleAddressBookChangePublication(context.simulationServicesOwner.getCurrent().ethereum.getRpcEntry()))),
	popup_changeActiveAddress: settingsCommand('popup_changeActiveAddress', async (context, request) => await changeActiveAddress(context.simulationServicesOwner, context.websiteTabConnections, request)),
	popup_changeActiveRpc: settingsCommand('popup_changeActiveRpc', async (context, request) => await popupChangeActiveRpc(context.simulationServicesOwner, context.websiteTabConnections, request)),
	popup_enableSimulationMode: settingsCommand('popup_enableSimulationMode', async (context, request) => {
		await enableSimulationMode(context.simulationServicesOwner, context.websiteTabConnections, request)
		return { type: 'PopupSettingsChangeReply', ok: true }
	}),
	popup_modifyMakeMeRich: settingsCommand('popup_modifyMakeMeRich', async (context, request) => {
		if (await modifyMakeMeRich(request)) {
			// Awaits the refresh deliberately, unlike other settings edits, so this command can report the refresh outcome in its reply.
			const outcome = await runPopupSimulationRefresh({ ...context.simulationServicesOwner.getCurrent(), invalidateOldState: true })
			if (outcome.status === 'observed' && !outcome.available) {
				return { type: 'PopupSettingsChangeReply', ok: false, message: 'The rich setting was saved, but the latest simulation is unavailable. Please refresh the simulation to retry.' }
			}
		}
		return { type: 'PopupSettingsChangeReply', ok: true }
	}),
} satisfies Pick<PopupMessageHandlerMap, PopupSettingsAdmittedRequest['method'] | 'popup_requestSettingsChangeStatus'>
