import { updateWebsiteApprovalAccesses } from '../accessManagement.js'
import { sendPopupMessageToOpenWindows } from '../backgroundUtils.js'
import { popupMessageHandler, type PopupMessageHandlerMap } from '../popupMessageHandlerRegistry.js'
import { changeSettings, exportSettings, importSettings, openNewTab, setNewRpcList, settingsOpened } from '../popupMessageHandlers.js'
import { getSettings } from '../settings.js'
import { updateContentScriptInjectionStrategy } from '../../utils/contentScriptsUpdating.js'
import { getErrorMessage } from '../../utils/errors.js'

// The imported settings are already stored when these run, so every step runs even after an earlier one fails. Each step either reports its own failure and resolves (the popup broadcast helper, the content script updater and reconciliation, which is called without throwOnError) or rejects; only rejections, such as a failed settings read, are collected and rethrown here for the caller's unexpected-error reporting, so every failure is either reported or rethrown.
async function runEveryFollowUpOfCommittedImport(followUps: readonly (() => Promise<void>)[]) {
	const failures: unknown[] = []
	for (const followUp of followUps) {
		try {
			await followUp()
		} catch (error: unknown) {
			failures.push(error)
		}
	}
	if (failures.length === 1) throw failures[0]
	if (failures.length > 1) throw new AggregateError(failures, `Applying the imported settings failed: ${ failures.map((failure) => getErrorMessage(failure) ?? 'unknown error').join('; ') }`)
}

export const settingsPopupMessageHandlers = {
	popup_requestSettings: popupMessageHandler('popup_requestSettings', async () => await settingsOpened()),
	popup_ChangeSettings: popupMessageHandler('popup_ChangeSettings', async (context, request) => await changeSettings(context.simulationServicesOwner, context.websiteTabConnections, request, context.simulationAbortController)),
	popup_openSettings: popupMessageHandler('popup_openSettings', async () => await openNewTab('settingsView')),
	popup_import_settings: popupMessageHandler('popup_import_settings', async (context, request) => {
		const importSettingsReply = await importSettings(request)
		if (!importSettingsReply.data.success) return await sendPopupMessageToOpenWindows(importSettingsReply)
		await runEveryFollowUpOfCommittedImport([
			async () => await sendPopupMessageToOpenWindows(importSettingsReply),
			// The import replaces the whole website access list, including the sites with the Interceptor disabled that manifest v3 excludes from content script injection.
			async () => await updateContentScriptInjectionStrategy(),
			async () => {
				const importedSettings = await getSettings()
				const popupRefreshGeneration = await updateWebsiteApprovalAccesses(context.simulationServicesOwner, context.websiteTabConnections, importedSettings, true)
				await sendPopupMessageToOpenWindows({ method: 'popup_settingsUpdated', data: importedSettings, popupRefreshGeneration })
			},
		])
	}),
	popup_get_export_settings: popupMessageHandler('popup_get_export_settings', async () => await exportSettings()),
	popup_set_rpc_list: popupMessageHandler('popup_set_rpc_list', async (context, request) => await setNewRpcList(context.simulationServicesOwner, request, context.settings)),
} satisfies Partial<PopupMessageHandlerMap>
