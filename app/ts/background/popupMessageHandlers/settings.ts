import type { ImportSettings, ImportSettingsReply, MessageToPopupPayload, SetRpcList, Settings } from '../../types/interceptor-messages.js'
import type { RpcEntries, RpcNetwork } from '../../types/rpc.js'
import { ExportedSettings } from '../../types/exportedSettingsTypes.js'
import { serialize } from '../../types/wire-types.js'
import { isJSON } from '../../utils/json.js'
import { Semaphore } from '../../utils/semaphore.js'
import { reportUnexpectedError } from '../../utils/errors.js'
import type { SimulationServicesOwner } from '../../simulation/serviceLifecycle.js'
import { exportSettingsAndAddressBook, getMetamaskCompatibilityMode, getSafeAppsCompatibilityMode, getSettingsSnapshot, getUseTabsInsteadOfPopup, importSettingsAndAddressBook, settingsIfAvailable, requireAvailableSettings, type SettingsSnapshot } from '../settings.js'
import { sendPopupMessageToOpenWindows } from '../backgroundUtils.js'
import { DEFAULT_RPCS } from '../../config/defaults.js'
import type { WebsiteTabConnections } from '../../types/user-interface-types.js'
import { retryRpcConfigurationServices, transitionRpcList } from '../rpcConfigurationLifecycle.js'
import { rpcConfigurationIsReady, rpcConfigurationIsUsable } from '../rpcConfigurationAvailability.js'

type PublishRpcConfigurationRecovery = (simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, previousSettings: Settings, activeRpcNetwork: Settings['activeRpcNetwork'], forceChainChanged?: boolean) => Promise<void>

type SettingsRpcStatus = {
	readonly rpcConfigurationAvailable: boolean
	readonly rpcEntries: RpcEntries
	readonly activeRpcNetwork: RpcNetwork | undefined
}

// Published when the RPC configuration could not be read at all: the Settings RPC section then offers Retry and Restore.
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

const formRpcListUpdate = ({ rpcEntries, rpcConfigurationAvailable }: SettingsRpcStatus): MessageToPopupPayload => ({ method: 'popup_update_rpc_list', data: { rpcEntries, rpcConfigurationAvailable } })

// Every RPC status the Settings page is sent (the settings reply and every RPC list update) is read and published inside this lock, from the configuration stored when the lock is held. Publications therefore go out in the order they were read, so a slow request can never publish a status older than one already published.
const rpcStatusPublicationSemaphore = new Semaphore(1)

async function publishCurrentRpcStatus(simulationServicesOwner: SimulationServicesOwner, formMessage: (rpcStatus: SettingsRpcStatus) => MessageToPopupPayload = formRpcListUpdate) {
	await rpcStatusPublicationSemaphore.execute(async () => {
		let rpcStatus: SettingsRpcStatus
		try {
			rpcStatus = getSettingsRpcStatus(await getSettingsSnapshot(), simulationServicesOwner)
		} catch (readError: unknown) {
			// The RPC section still leaves its loading state, showing Retry and Restore; the read error then reaches the caller.
			await sendPopupMessageToOpenWindows(formRpcListUpdate(UNREADABLE_RPC_STATUS))
			throw readError
		}
		await sendPopupMessageToOpenWindows(formMessage(rpcStatus))
	})
}

async function readSettingsPreferences() {
	try {
		const [useTabsInsteadOfPopup, metamaskCompatibilityMode, safeAppsCompatibilityMode] = await Promise.all([getUseTabsInsteadOfPopup(), getMetamaskCompatibilityMode(), getSafeAppsCompatibilityMode()])
		return { status: 'read' as const, preferences: { useTabsInsteadOfPopup, metamaskCompatibilityMode, safeAppsCompatibilityMode } }
	} catch (error: unknown) {
		return { status: 'failed' as const, error }
	}
}

// The Settings RPC section leaves its loading state only on an RPC status published here, so the status is published even when the preferences cannot be read: as the settings reply when they were read, otherwise as an RPC list update, after which the preference failure reaches the caller and is reported.
export async function settingsOpened(simulationServicesOwner: SimulationServicesOwner) {
	const preferences = await readSettingsPreferences()
	try {
		await publishCurrentRpcStatus(simulationServicesOwner, preferences.status === 'read'
			? (rpcStatus) => ({ method: 'popup_requestSettingsReply', data: { ...preferences.preferences, ...rpcStatus } })
			: formRpcListUpdate)
	} catch (publicationError: unknown) {
		// Only one error reaches the caller, so a preference failure of the same request is reported here.
		if (preferences.status === 'failed') await reportUnexpectedError(preferences.error)
		throw publicationError
	}
	if (preferences.status === 'failed') throw preferences.error
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
	try {
		await publishCurrentRpcStatus(simulationServicesOwner)
	} finally {
		// The transition is committed, so its recovery is published even if its RPC status could not be.
		if (transition.publishRecovery) await publishRecovery(simulationServicesOwner, websiteTabConnections, settings, transition.activeRpcNetwork, transition.forceChainChanged)
	}
}

export async function restoreDefaultRpcConfiguration(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, settings: Settings | undefined, publishRecovery: PublishRpcConfigurationRecovery) {
	const transition = await transitionRpcList(simulationServicesOwner, DEFAULT_RPCS, 'restore-defaults')
	try {
		await publishCurrentRpcStatus(simulationServicesOwner)
	} finally {
		// The transition is committed, so its recovery is published even if its RPC status could not be.
		if (transition.publishRecovery) await publishRecovery(simulationServicesOwner, websiteTabConnections, settings ?? requireAvailableSettings(await getSettingsSnapshot()), transition.activeRpcNetwork, transition.forceChainChanged)
	}
}

export async function retryRpcConfiguration(simulationServicesOwner: SimulationServicesOwner, reconcileAccessRules: () => Promise<void>) {
	const retriedConfiguration = await retryRpcConfigurationServices(simulationServicesOwner)
	try {
		await publishCurrentRpcStatus(simulationServicesOwner)
	} finally {
		// Services already resumed, so their access rules are reconciled even if the RPC status could not be published.
		if (retriedConfiguration !== undefined) await reconcileAccessRules()
	}
}
