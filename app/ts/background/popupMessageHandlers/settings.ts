import type { ChangeActiveChain, ChangeSettings, ImportSettings, ImportSettingsReply, SetRpcList, Settings } from '../../types/interceptor-messages.js'
import type { WebsiteTabConnections } from '../../types/user-interface-types.js'
import { ExportedSettings } from '../../types/exportedSettingsTypes.js'
import { serialize } from '../../types/wire-types.js'
import { isJSON } from '../../utils/json.js'
import { silenceChromeUnCaughtPromise } from '../../utils/requests.js'
import { updateContentScriptInjectionStrategy } from '../../utils/contentScriptsUpdating.js'
import type { SimulationServicesOwner } from '../../simulation/serviceLifecycle.js'
import { getPrimaryRpcForChain, getRpcList, setRpcList } from '../storageVariables.js'
import { exportSettingsAndAddressBook, getMetamaskCompatibilityMode, getSafeAppsCompatibilityMode, getSettings, getUseTabsInsteadOfPopup, importSettingsAndAddressBook, setMetamaskCompatibilityMode, setSafeAppsCompatibilityMode, setUseTabsInsteadOfPopup } from '../settings.js'
import { sendPopupMessageToOpenWindows } from '../backgroundUtils.js'
import { getLastKnownCurrentTabId } from '../currentTab.js'
import { bumpPopupRefreshGeneration } from '../popupRefreshGeneration.js'
import { changeActiveRpc } from '../walletSwitch.js'
import { requestNewHomeData } from './home.js'

export async function settingsOpened() {
	const useTabsInsteadOfPopupPromise = silenceChromeUnCaughtPromise(getUseTabsInsteadOfPopup())
	const metamaskCompatibilityModePromise = silenceChromeUnCaughtPromise(getMetamaskCompatibilityMode())
	const safeAppsCompatibilityModePromise = silenceChromeUnCaughtPromise(getSafeAppsCompatibilityMode())
	const rpcEntriesPromise = silenceChromeUnCaughtPromise(getRpcList())
	const settingsPromise = silenceChromeUnCaughtPromise(getSettings())

	await sendPopupMessageToOpenWindows({
		method: 'popup_requestSettingsReply' as const,
		data: {
			useTabsInsteadOfPopup: await useTabsInsteadOfPopupPromise,
			metamaskCompatibilityMode: await metamaskCompatibilityModePromise,
			safeAppsCompatibilityMode: await safeAppsCompatibilityModePromise,
			rpcEntries: await rpcEntriesPromise,
			activeRpcNetwork: (await settingsPromise).activeRpcNetwork
		}
	})
}

export async function importSettings(settingsData: ImportSettings): Promise<ImportSettingsReply> {
	if (!isJSON(settingsData.data.fileContents)) {
		return { method: 'popup_initiate_export_settings_reply', data: { success: false, errorMessage: 'Failed to read the file. It is not a valid JSON file.' } }
	}
	const parsed = ExportedSettings.safeParse(JSON.parse(settingsData.data.fileContents))
	if (!parsed.success) {
		return { method: 'popup_initiate_export_settings_reply', data: { success: false, errorMessage: 'Failed to read the file. It is not a valid interceptor settings file' } }
	}
	await importSettingsAndAddressBook(parsed.value)
	// The content scripts are registered with the disabled sites excluded, so an import that changes them has to register again.
	await updateContentScriptInjectionStrategy()
	return { method: 'popup_initiate_export_settings_reply', data: { success: true } }
}

export async function exportSettings() {
	const exportedSettings = await exportSettingsAndAddressBook()
	await sendPopupMessageToOpenWindows({
		method: 'popup_initiate_export_settings',
		data: { fileContents: JSON.stringify(serialize(ExportedSettings, exportedSettings), undefined, 4) }
	})
}

export async function setNewRpcList(simulationServicesOwner: SimulationServicesOwner, request: SetRpcList, settings: Settings) {
	await setRpcList(request.data)
	await sendPopupMessageToOpenWindows({ method: 'popup_update_rpc_list', data: request.data })
	const primary = await getPrimaryRpcForChain(settings.activeRpcNetwork.chainId)
	if (primary !== undefined) simulationServicesOwner.reset(primary)
}

export async function changeSettings(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, parsedRequest: ChangeSettings, requestAbortController: AbortController | undefined) {
	if (parsedRequest.data.useTabsInsteadOfPopup !== undefined) await setUseTabsInsteadOfPopup(parsedRequest.data.useTabsInsteadOfPopup)
	if (parsedRequest.data.metamaskCompatibilityMode !== undefined) await setMetamaskCompatibilityMode(parsedRequest.data.metamaskCompatibilityMode)
	if (parsedRequest.data.safeAppsCompatibilityMode !== undefined) {
		await setSafeAppsCompatibilityMode(parsedRequest.data.safeAppsCompatibilityMode)
	}
	return await requestNewHomeData(simulationServicesOwner.getCurrent().ethereum, websiteTabConnections, false, true, requestAbortController, bumpPopupRefreshGeneration())
}

export async function popupChangeActiveRpc(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, params: ChangeActiveChain) {
	const result = await changeActiveRpc(simulationServicesOwner, websiteTabConnections, params.data, { source: 'popup', signerTabId: await getLastKnownCurrentTabId() })
	if (result.error !== undefined) return { type: 'PopupSettingsChangeReply', ok: false, message: result.error.message } as const
	return { type: 'PopupSettingsChangeReply', ok: true } as const
}
