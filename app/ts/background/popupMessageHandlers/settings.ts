import type { ImportSettings, ImportSettingsReply, SetRpcList, Settings } from '../../types/interceptor-messages.js'
import type { RpcEntries, RpcNetwork } from '../../types/rpc.js'
import { ExportedSettings } from '../../types/exportedSettingsTypes.js'
import { serialize } from '../../types/wire-types.js'
import { isJSON } from '../../utils/json.js'
import { silenceChromeUnCaughtPromise } from '../../utils/requests.js'
import type { SimulationServicesOwner } from '../../simulation/serviceLifecycle.js'
import { exportSettingsAndAddressBook, getMetamaskCompatibilityMode, getSafeAppsCompatibilityMode, getSettingsSnapshot, getUseTabsInsteadOfPopup, importSettingsAndAddressBook, settingsIfAvailable, requireAvailableSettings, type SettingsSnapshot } from '../settings.js'
import { sendPopupMessageToOpenWindows } from '../backgroundUtils.js'
import { DEFAULT_RPCS } from '../../config/defaults.js'
import type { WebsiteTabConnections } from '../../types/user-interface-types.js'
import { retryRpcConfigurationServices, transitionRpcList } from '../rpcConfigurationLifecycle.js'
import { rpcConfigurationIsReady, rpcConfigurationIsUsable } from '../rpcConfigurationAvailability.js'

type PublishRpcConfigurationRecovery = (simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, previousSettings: Settings, activeRpcNetwork: Settings['activeRpcNetwork'], forceChainChanged?: boolean) => Promise<void>

async function sendRpcListUpdate(rpcEntries: SetRpcList['data'], rpcConfigurationAvailable: boolean) {
	await sendPopupMessageToOpenWindows({ method: 'popup_update_rpc_list', data: { rpcEntries, rpcConfigurationAvailable } })
}

type SettingsRpcStatus = {
	readonly rpcConfigurationAvailable: boolean
	readonly rpcEntries: RpcEntries
	readonly activeRpcNetwork: RpcNetwork | undefined
}

// Shown when the RPC configuration could not be read at all: the Settings RPC section then offers Retry and Restore.
const UNREADABLE_RPC_STATUS: SettingsRpcStatus = { rpcConfigurationAvailable: false, rpcEntries: [], activeRpcNetwork: undefined }

function getSettingsRpcStatus(settingsSnapshot: SettingsSnapshot, simulationServicesOwner: SimulationServicesOwner): SettingsRpcStatus {
	const { rpcConfiguration } = settingsSnapshot
	const rpcConfigurationAvailable = rpcConfigurationIsUsable(rpcConfiguration, simulationServicesOwner)
	return {
		rpcConfigurationAvailable,
		rpcEntries: rpcConfigurationAvailable && rpcConfigurationIsReady(rpcConfiguration) ? rpcConfiguration.rpcEntries : [],
		activeRpcNetwork: settingsIfAvailable(settingsSnapshot)?.activeRpcNetwork,
	}
}

// The Settings RPC section leaves its loading state only on the RPC status this publishes, so the status is published even when the request fails, for example when a preference read rejects: it is sent as an RPC list update (unreadable when the RPC configuration itself could not be read) before the failure reaches the caller, and the section shows the RPC list or its Retry and Restore controls.
export async function settingsOpened(simulationServicesOwner: SimulationServicesOwner) {
	const preferencesPromise = silenceChromeUnCaughtPromise(Promise.all([getUseTabsInsteadOfPopup(), getMetamaskCompatibilityMode(), getSafeAppsCompatibilityMode()]))
	let rpcStatus = UNREADABLE_RPC_STATUS
	try {
		rpcStatus = getSettingsRpcStatus(await getSettingsSnapshot(), simulationServicesOwner)
		const [useTabsInsteadOfPopup, metamaskCompatibilityMode, safeAppsCompatibilityMode] = await preferencesPromise
		await sendPopupMessageToOpenWindows({
			method: 'popup_requestSettingsReply' as const,
			data: { useTabsInsteadOfPopup, metamaskCompatibilityMode, safeAppsCompatibilityMode, ...rpcStatus },
		})
	} catch (error: unknown) {
		await sendRpcListUpdate(rpcStatus.rpcEntries, rpcStatus.rpcConfigurationAvailable)
		throw error
	}
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
	if (transition.publishRecovery) await publishRecovery(simulationServicesOwner, websiteTabConnections, settings ?? requireAvailableSettings(await getSettingsSnapshot()), transition.activeRpcNetwork, transition.forceChainChanged)
}

export async function retryRpcConfiguration(simulationServicesOwner: SimulationServicesOwner, reconcileAccessRules: () => Promise<void>) {
	const retriedConfiguration = await retryRpcConfigurationServices(simulationServicesOwner)
	if (retriedConfiguration === undefined) {
		await sendRpcListUpdate([], false)
		return
	}
	await sendRpcListUpdate(retriedConfiguration.rpcEntries, true)
	await reconcileAccessRules()
}
