import type { ImportSettings, ImportSettingsReply, MessageToPopupPayload, SetRpcList, Settings } from '../../types/interceptor-messages.js'
import type { RpcEntries, RpcNetwork } from '../../types/rpc.js'
import { ExportedSettings } from '../../types/exportedSettingsTypes.js'
import { serialize } from '../../types/wire-types.js'
import { isJSON } from '../../utils/json.js'
import { Semaphore } from '../../utils/semaphore.js'
import type { SimulationServicesOwner } from '../../simulation/serviceLifecycle.js'
import { exportSettingsAndAddressBook, getMetamaskCompatibilityMode, getSafeAppsCompatibilityMode, getSettingsSnapshot, getUseTabsInsteadOfPopup, importSettingsAndAddressBook, settingsIfAvailable, type SettingsSnapshot } from '../settings.js'
import { sendPopupMessageToOpenWindows } from '../backgroundUtils.js'
import { DEFAULT_RPCS } from '../../config/defaults.js'
import type { WebsiteTabConnections } from '../../types/user-interface-types.js'
import { applyRpcServicesChange, readRpcConfigurationRetry, type RpcListTransitionResult, transitionRpcList } from '../rpcConfigurationLifecycle.js'
import { reconcileAfterIndependentSteps } from '../committedWriteReconciliation.js'
import { rpcConfigurationIsReady, rpcConfigurationIsUsable } from '../rpcConfigurationAvailability.js'

type PublishRpcConfigurationRecovery = (simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, previousSettings: Settings | undefined, activeRpcNetwork: Settings['activeRpcNetwork'], forceChainChanged?: boolean) => Promise<readonly unknown[]>

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

const publishRpcListUpdate = async (rpcStatus: SettingsRpcStatus) => await sendPopupMessageToOpenWindows(formRpcListUpdate(rpcStatus))

// A failed storage read is not thrown: getSettingsSnapshot returns it as the 'read-failed' unavailable configuration, published here as an unavailable status, and the Settings alert with Retry and Restore is how it is surfaced (deliberately not as an unexpected error). The catch handles only an unexpected exception while reading or forming the status: it still publishes the unreadable status so the RPC section leaves loading, then rethrows for the caller to report once.
async function publishCurrentRpcStatus(simulationServicesOwner: SimulationServicesOwner, publish: (rpcStatus: SettingsRpcStatus) => Promise<void> = publishRpcListUpdate) {
	await rpcStatusPublicationSemaphore.execute(async () => {
		let rpcStatus: SettingsRpcStatus
		try {
			rpcStatus = getSettingsRpcStatus(await getSettingsSnapshot(), simulationServicesOwner)
		} catch (unexpectedError: unknown) {
			await publishRpcListUpdate(UNREADABLE_RPC_STATUS)
			throw unexpectedError
		}
		await publish(rpcStatus)
	})
}

// The preference getters read storage directly and take no lock, so they are safe to read inside the publication lock.
async function readSettingsPreferences() {
	const [useTabsInsteadOfPopup, metamaskCompatibilityMode, safeAppsCompatibilityMode] = await Promise.all([getUseTabsInsteadOfPopup(), getMetamaskCompatibilityMode(), getSafeAppsCompatibilityMode()])
	return { useTabsInsteadOfPopup, metamaskCompatibilityMode, safeAppsCompatibilityMode }
}

// The reply's RPC status and preferences are both read and published inside the publication lock, so replies go out in the order they were read and none shows values older than an earlier reply. An unreadable RPC configuration is part of the reply (see publishCurrentRpcStatus). When the preferences cannot be read, the RPC status is still published, as an RPC list update, so the RPC section leaves loading, and the preference error reaches the caller, which reports it.
export async function settingsOpened(simulationServicesOwner: SimulationServicesOwner) {
	await publishCurrentRpcStatus(simulationServicesOwner, async (rpcStatus) => {
		const preferences = await readSettingsPreferences().catch(async (preferenceError: unknown) => {
			await publishRpcListUpdate(rpcStatus)
			throw preferenceError
		})
		await sendPopupMessageToOpenWindows({ method: 'popup_requestSettingsReply', data: { ...preferences, ...rpcStatus } })
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

// A committed RPC configuration write runs under the committed-write rule with one failure collector (reconcileAfterIndependentSteps): its services change and then its RPC status publication are independent steps, its recovery publication (which reconciles website access and returns its own failures) always runs after them, and every failure is surfaced afterwards in the order it occurred, the first thrown and the rest reported.
async function completeRpcListTransition(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, transition: RpcListTransitionResult, settings: Settings | undefined, publishRecovery: PublishRpcConfigurationRecovery) {
	await reconcileAfterIndependentSteps([
		async () => applyRpcServicesChange(simulationServicesOwner, transition.servicesChange),
		async () => await publishCurrentRpcStatus(simulationServicesOwner),
	], async () => transition.publishRecovery ? await publishRecovery(simulationServicesOwner, websiteTabConnections, settings, transition.activeRpcNetwork, transition.forceChainChanged) : [])
}

export async function setNewRpcList(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, request: SetRpcList, settings: Settings, publishRecovery: PublishRpcConfigurationRecovery) {
	await completeRpcListTransition(simulationServicesOwner, websiteTabConnections, await transitionRpcList(simulationServicesOwner, request.data, 'edit'), settings, publishRecovery)
}

export async function restoreDefaultRpcConfiguration(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, settings: Settings | undefined, publishRecovery: PublishRpcConfigurationRecovery) {
	await completeRpcListTransition(simulationServicesOwner, websiteTabConnections, await transitionRpcList(simulationServicesOwner, DEFAULT_RPCS, 'restore-defaults'), settings, publishRecovery)
}

// Retry writes nothing, but follows the same rule: the services change and the RPC status publication are independent steps, and a ready configuration's access rules are reconciled after them even if either failed.
export async function retryRpcConfiguration(simulationServicesOwner: SimulationServicesOwner, reconcileAccessRules: () => Promise<void>) {
	const { retriedConfiguration, servicesChange } = await readRpcConfigurationRetry()
	await reconcileAfterIndependentSteps([
		async () => applyRpcServicesChange(simulationServicesOwner, servicesChange),
		async () => await publishCurrentRpcStatus(simulationServicesOwner),
	], async () => {
		if (retriedConfiguration !== undefined) await reconcileAccessRules()
		return []
	})
}
