import { updateWebsiteApprovalAccesses } from '../accessManagement.js'
import { sendPopupMessageToOpenWindows } from '../backgroundUtils.js'
import { popupMessageHandler, popupSnapshotMessageHandler, type PopupMessageHandlerMap } from '../popupMessageHandlerRegistry.js'
import { changeSettings, exportSettings, importSettings, openNewTab, setNewRpcList, settingsOpened } from '../popupMessageHandlers.js'
import { getSettings, setDelegateClearingEnabled } from '../settings.js'
import { getCachedDelegation } from '../delegationSimulation.js'
import { queuePopupSimulationRefresh } from '../popupSimulationRefreshQueue.js'
import { isExpectedInfrastructureError, reportUnexpectedError } from '../../utils/errors.js'
import { bumpPopupRefreshGeneration } from '../popupRefreshGeneration.js'

export const settingsPopupMessageHandlers = {
	popup_requestSettings: popupMessageHandler('popup_requestSettings', async () => await settingsOpened()),
	popup_ChangeSettings: popupMessageHandler('popup_ChangeSettings', async (context, request) => await changeSettings(context.simulationServicesOwner, context.websiteTabConnections, request, context.simulationAbortController)),
	popup_openSettings: popupMessageHandler('popup_openSettings', async () => await openNewTab('settingsView')),
	popup_import_settings: popupMessageHandler('popup_import_settings', async (context, request) => {
		const importSettingsReply = await importSettings(request)
		await sendPopupMessageToOpenWindows(importSettingsReply)
		if (!importSettingsReply.data.success) return
		const importedSettings = await getSettings()
		const popupRefreshGeneration = await updateWebsiteApprovalAccesses(context.simulationServicesOwner, context.websiteTabConnections, importedSettings, true)
		await sendPopupMessageToOpenWindows({ method: 'popup_settingsUpdated', data: importedSettings, popupRefreshGeneration })
	}),
	popup_get_export_settings: popupMessageHandler('popup_get_export_settings', async () => await exportSettings()),
	popup_set_rpc_list: popupMessageHandler('popup_set_rpc_list', async (context, request) => await setNewRpcList(context.simulationServicesOwner, request, context.settings)),
	popup_requestDelegationSimulation: popupSnapshotMessageHandler('popup_requestDelegationSimulation', async (context, request) => {
		const { address, chainId } = request.data
		const network = context.settings.activeRpcNetwork
		const providerNetwork = context.services.ethereum.getRpcEntry()
		if (!context.settings.simulationMode || context.settings.activeSimulationAddress !== address || network.chainId !== chainId
			|| network.httpsRpc === undefined || providerNetwork.chainId !== chainId || providerNetwork.httpsRpc !== network.httpsRpc) {
			return { method: 'popup_requestDelegationSimulation', data: { address, chainId, status: { type: 'unknown' } } }
		}
		try {
			const delegate = await getCachedDelegation(context.services.ethereum, address)
			return { method: 'popup_requestDelegationSimulation', data: { address, chainId, status: delegate === undefined ? { type: 'none' } : { type: 'delegated', delegate } } }
		} catch (error) {
			if (!isExpectedInfrastructureError(error)) await reportUnexpectedError(error, { code: 'active_delegation_lookup_failed' })
			return { method: 'popup_requestDelegationSimulation', data: { address, chainId, status: { type: 'unknown' } } }
		}
	}),
	popup_setDelegationSimulation: popupSnapshotMessageHandler('popup_setDelegationSimulation', async (context, request) => {
		const { address, chainId, enabled } = request.data
		const network = context.settings.activeRpcNetwork
		if (!context.settings.simulationMode || context.settings.activeSimulationAddress !== address || network.chainId !== chainId) {
			return { method: 'popup_setDelegationSimulation', data: { ok: false, message: 'The active simulation account or network changed. Please try again.' } }
		}
		if (enabled) {
			const providerNetwork = context.services.ethereum.getRpcEntry()
			if (network.httpsRpc === undefined || providerNetwork.chainId !== chainId || providerNetwork.httpsRpc !== network.httpsRpc) {
				return { method: 'popup_setDelegationSimulation', data: { ok: false, message: 'The active simulation network changed. Please try again.' } }
			}
			if (await getCachedDelegation(context.services.ethereum, address) === undefined) {
				return { method: 'popup_setDelegationSimulation', data: { ok: false, message: 'This account no longer has an EIP-7702 delegate.' } }
			}
		}
		const changed = await setDelegateClearingEnabled(address, chainId, enabled)
		if (changed) {
			await sendPopupMessageToOpenWindows({ method: 'popup_settingsUpdated', data: await getSettings(), popupRefreshGeneration: bumpPopupRefreshGeneration() })
			await queuePopupSimulationRefresh({ ...context.services, invalidateOldState: true })
		}
		return { method: 'popup_setDelegationSimulation', data: { ok: true, address, chainId, enabled } }
	}),
} satisfies Partial<PopupMessageHandlerMap>
