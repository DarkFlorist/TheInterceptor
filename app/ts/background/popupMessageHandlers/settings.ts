import type { ImportSettings, ImportSettingsReply, SetRpcList, Settings } from '../../types/interceptor-messages.js'
import { ExportedSettings } from '../../types/exportedSettingsTypes.js'
import { serialize } from '../../types/wire-types.js'
import { isJSON } from '../../utils/json.js'
import { silenceChromeUnCaughtPromise } from '../../utils/requests.js'
import type { SimulationServicesOwner } from '../../simulation/serviceLifecycle.js'
import { getRpcConfigurationState, getRpcServiceNetwork, setRpcConfiguration, setRpcList } from '../storageVariables.js'
import { exportSettingsAndAddressBook, getMetamaskCompatibilityMode, getSafeAppsCompatibilityMode, getSettings, getUseTabsInsteadOfPopup, importSettingsAndAddressBook } from '../settings.js'
import { sendPopupMessageToOpenWindows } from '../backgroundUtils.js'
import { DEFAULT_RPCS } from '../../config/defaults.js'

export async function settingsOpened(simulationServicesOwner: SimulationServicesOwner) {
	const useTabsInsteadOfPopupPromise = silenceChromeUnCaughtPromise(getUseTabsInsteadOfPopup())
	const metamaskCompatibilityModePromise = silenceChromeUnCaughtPromise(getMetamaskCompatibilityMode())
	const safeAppsCompatibilityModePromise = silenceChromeUnCaughtPromise(getSafeAppsCompatibilityMode())
	const rpcConfigurationPromise = silenceChromeUnCaughtPromise(getRpcConfigurationState())
	const settingsPromise = silenceChromeUnCaughtPromise(getSettings())
	const [useTabsInsteadOfPopup, metamaskCompatibilityMode, safeAppsCompatibilityMode, rpcConfiguration, settings] = await Promise.all([
		useTabsInsteadOfPopupPromise,
		metamaskCompatibilityModePromise,
		safeAppsCompatibilityModePromise,
		rpcConfigurationPromise,
		settingsPromise,
	])
	if (rpcConfiguration.status === 'unavailable') simulationServicesOwner.clear()
	const rpcConfigurationAvailable = rpcConfiguration.status === 'ready' && simulationServicesOwner.isAvailable()

	await sendPopupMessageToOpenWindows({
		method: 'popup_requestSettingsReply' as const,
		data: {
			useTabsInsteadOfPopup,
			metamaskCompatibilityMode,
			safeAppsCompatibilityMode,
			rpcConfigurationAvailable,
			rpcEntries: rpcConfigurationAvailable ? rpcConfiguration.rpcEntries : [],
			activeRpcNetwork: settings.activeRpcNetwork
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
	const previousConfiguration = await getRpcConfigurationState()
	if (previousConfiguration.status === 'unavailable' || !simulationServicesOwner.isAvailable()) throw new Error('RPC configuration is unavailable. Restore it before editing RPC connections.')
	if (request.data.length === 0) {
		await setRpcList(request.data)
		simulationServicesOwner.clear()
		await sendPopupMessageToOpenWindows({ method: 'popup_update_rpc_list', data: request.data })
		return
	}
	await setRpcList(request.data)
	if (!simulationServicesOwner.isAvailable()) throw new Error('RPC configuration became unavailable while saving RPC connections.')
	const primary = request.data.find((rpc) => rpc.chainId === settings.activeRpcNetwork.chainId && rpc.primary)
	if (primary !== undefined) simulationServicesOwner.reset(primary)
	await sendPopupMessageToOpenWindows({ method: 'popup_update_rpc_list', data: request.data })
}

export async function restoreDefaultRpcConfiguration(simulationServicesOwner: SimulationServicesOwner) {
	const activeRpcNetwork = DEFAULT_RPCS[0]
	if (activeRpcNetwork === undefined) throw new Error('Bundled RPC configuration is empty.')
	await setRpcConfiguration(DEFAULT_RPCS, activeRpcNetwork)
	simulationServicesOwner.recover(activeRpcNetwork)
	await sendPopupMessageToOpenWindows({ method: 'popup_update_rpc_list', data: DEFAULT_RPCS })
}

export async function retryRpcConfiguration(simulationServicesOwner: SimulationServicesOwner) {
	const configuration = await getRpcConfigurationState()
	if (configuration.status !== 'ready') {
		simulationServicesOwner.clear()
		await sendPopupMessageToOpenWindows({ method: 'popup_update_rpc_list', data: [] })
		return
	}
	const rpcNetwork = getRpcServiceNetwork(configuration)
	if (rpcNetwork === undefined) {
		simulationServicesOwner.clear()
		await sendPopupMessageToOpenWindows({ method: 'popup_update_rpc_list', data: [] })
		return
	}
	simulationServicesOwner.recover(rpcNetwork)
	await sendPopupMessageToOpenWindows({ method: 'popup_update_rpc_list', data: configuration.rpcEntries })
}
