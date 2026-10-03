import type { ImportSettings, ImportSettingsReply, SetRpcList, Settings } from '../../types/interceptor-messages.js'
import { ExportedSettings } from '../../types/exportedSettingsTypes.js'
import { serialize } from '../../types/wire-types.js'
import { isJSON } from '../../utils/json.js'
import { silenceChromeUnCaughtPromise } from '../../utils/requests.js'
import type { SimulationServicesOwner } from '../../simulation/serviceLifecycle.js'
import { getRpcConfigurationState } from '../storageVariables.js'
import { exportSettingsAndAddressBook, getMetamaskCompatibilityMode, getSafeAppsCompatibilityMode, getRequiredSettings, getSettingsSnapshot, getUseTabsInsteadOfPopup, importSettingsAndAddressBook } from '../settings.js'
import { sendPopupMessageToOpenWindows } from '../backgroundUtils.js'
import { DEFAULT_RPCS } from '../../config/defaults.js'
import type { WebsiteTabConnections } from '../../types/user-interface-types.js'
import { transitionRpcList } from '../rpcConfigurationLifecycle.js'
import { resolveRpcServicesTarget, rpcConfigurationIsReady, rpcConfigurationIsUsable } from '../rpcConfigurationAvailability.js'

type PublishRpcConfigurationRecovery = (simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, previousSettings: Settings, activeRpcNetwork: Settings['activeRpcNetwork'], forceChainChanged?: boolean) => Promise<void>

async function sendRpcListUpdate(rpcEntries: SetRpcList['data'], rpcConfigurationAvailable: boolean) {
	await sendPopupMessageToOpenWindows({ method: 'popup_update_rpc_list', data: { rpcEntries, rpcConfigurationAvailable } })
}

export async function settingsOpened(simulationServicesOwner: SimulationServicesOwner) {
	const useTabsInsteadOfPopupPromise = silenceChromeUnCaughtPromise(getUseTabsInsteadOfPopup())
	const metamaskCompatibilityModePromise = silenceChromeUnCaughtPromise(getMetamaskCompatibilityMode())
	const safeAppsCompatibilityModePromise = silenceChromeUnCaughtPromise(getSafeAppsCompatibilityMode())
	const settingsSnapshotPromise = silenceChromeUnCaughtPromise(getSettingsSnapshot())
	const [useTabsInsteadOfPopup, metamaskCompatibilityMode, safeAppsCompatibilityMode, settingsSnapshot] = await Promise.all([
		useTabsInsteadOfPopupPromise,
		metamaskCompatibilityModePromise,
		safeAppsCompatibilityModePromise,
		settingsSnapshotPromise,
	])
	const { rpcConfiguration, settings } = settingsSnapshot
	const rpcConfigurationAvailable = rpcConfigurationIsUsable(rpcConfiguration, simulationServicesOwner)

	await sendPopupMessageToOpenWindows({
		method: 'popup_requestSettingsReply' as const,
		data: {
			useTabsInsteadOfPopup,
			metamaskCompatibilityMode,
			safeAppsCompatibilityMode,
			rpcConfigurationAvailable,
			rpcEntries: rpcConfigurationAvailable && rpcConfigurationIsReady(rpcConfiguration) ? rpcConfiguration.rpcEntries : [],
			activeRpcNetwork: settings?.activeRpcNetwork
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

export async function setNewRpcList(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, request: SetRpcList, settings: Settings, publishRecovery: PublishRpcConfigurationRecovery) {
	const transition = await transitionRpcList(simulationServicesOwner, request.data, 'edit')
	await sendRpcListUpdate(request.data, transition.rpcConfigurationAvailable)
	if (transition.publishRecovery) await publishRecovery(simulationServicesOwner, websiteTabConnections, settings, transition.activeRpcNetwork, transition.forceChainChanged)
}

export async function restoreDefaultRpcConfiguration(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, settings: Settings | undefined, publishRecovery: PublishRpcConfigurationRecovery) {
	const transition = await transitionRpcList(simulationServicesOwner, DEFAULT_RPCS, 'restore-defaults')
	await sendRpcListUpdate(DEFAULT_RPCS, true)
	if (transition.publishRecovery) await publishRecovery(simulationServicesOwner, websiteTabConnections, settings ?? await getRequiredSettings(), transition.activeRpcNetwork, transition.forceChainChanged)
}

export async function retryRpcConfiguration(simulationServicesOwner: SimulationServicesOwner) {
	const configuration = await getRpcConfigurationState()
	if (configuration.status !== 'ready') {
		simulationServicesOwner.clear()
		await sendRpcListUpdate([], false)
		return
	}
	const rpcNetwork = resolveRpcServicesTarget(configuration)
	if (rpcNetwork === undefined) {
		simulationServicesOwner.clear()
		await sendRpcListUpdate(configuration.rpcEntries, true)
		return
	}
	simulationServicesOwner.recover(rpcNetwork)
	await sendRpcListUpdate(configuration.rpcEntries, true)
}
