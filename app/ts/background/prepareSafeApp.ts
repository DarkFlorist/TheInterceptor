import { getChromeFileInjector } from './chromeScriptInjection.js'
import { contentScriptRegistration } from './contentScriptRegistration.js'
import { isMissingBrowserTargetError } from '../utils/requests.js'
import type { PrepareSafeAppReply } from '../types/interceptor-reply-messages.js'
import { getEnabledSafeAppsHostOrigins, getSettings } from './settings.js'
import { hasAccess } from './websiteAccessPolicy.js'
import { parseSafeAppsHostOrigin } from '../types/safeAppsHosting.js'

async function prepareSafeAppTabOperation(value: string, operation: PreparationOperation): Promise<PrepareSafeAppReply['data']> {
	const origin = parseSafeAppsHostOrigin(value)
	if (browser.runtime.getManifest().manifest_version !== 3) return { success: false, errorMessage: 'Safe Apps hosting requires Chrome.' }
	if (!(await getEnabledSafeAppsHostOrigins()).includes(origin)) return { success: false, errorMessage: 'Enable Safe Apps compatibility and add this website first.' }
	const settings = await getSettings()
	if (settings.simulationMode || settings.activeSigningSafeAddress === undefined) return { success: false, errorMessage: 'Select a Safe in signing mode before connecting this app.' }
	const access = hasAccess(settings.websiteAccess, new URL(origin).host)
	if (access === 'interceptorDisabled') return { success: false, errorMessage: 'Enable Interceptor on this website before connecting.' }
	if (access === 'noAccess') return { success: false, errorMessage: 'Allow this website in Website Access before connecting.' }
	const tabs = await browser.tabs.query({})
	const tab = tabs.find((tab) => tab.id !== undefined && tab.url !== undefined && new URL(tab.url).origin === origin)
	if (tab?.id === undefined) return { success: false, errorMessage: 'Open this website in a browser tab before connecting.' }
	const injectFiles = getChromeFileInjector()
	if (injectFiles === undefined) return { success: false, errorMessage: 'This browser does not support Safe Apps connection preparation.' }
	operation.tabId = tab.id
	// Read the actual origin in the isolated world and bind preparation to that document, even if the tab navigates.
	const documents = await injectFiles({ target: { tabId: tab.id, frameIds: [0] }, world: 'ISOLATED', files: ['/inpage/js/readDocumentOrigin.js'] })
	const document = documents[0]
	if (document === undefined || document.result !== origin) return { success: false, errorMessage: 'The website navigated before connecting.' }
	if (document.documentId === undefined) return { success: false, errorMessage: 'This browser does not support Safe Apps connection preparation.' }
	if (operation.abort.signal.aborted) return cancelledReply(operation)
	operation.documentId = document.documentId
	const results = await Promise.race([injectFiles({ target: { tabId: tab.id, documentIds: [document.documentId] }, world: 'MAIN', files: ['/inpage/js/prepareSafeAppBootstrap.js'] }), operation.cancelled])
	if (operation.abort.signal.aborted) return cancelledReply(operation)
	const result = results?.[0]?.result
	if (typeof result !== 'object' || result === null || !('success' in result) || result.success !== true) {
		return { success: false, errorMessage: typeof result === 'object' && result !== null && 'error' in result && typeof result.error === 'string' ? result.error : 'The website did not confirm a Safe connection.' }
	}
	// Persisted hosting settings can be ahead of the storage observer's registration queue.
	const hostRegistered = await Promise.race([contentScriptRegistration.ensureSafeAppsHostRegistered(origin), operation.cancelled])
	if (operation.abort.signal.aborted) return cancelledReply(operation)
	if (!hostRegistered) return { success: false, errorMessage: 'Safe Apps hosting could not be registered for this website. Check the hosting settings and retry.' }
	const latestSettings = await getSettings()
	const latestAccess = hasAccess(latestSettings.websiteAccess, new URL(origin).host)
	if (latestAccess === 'interceptorDisabled') return { success: false, errorMessage: 'Enable Interceptor on this website before connecting.' }
	if (latestAccess !== 'hasAccess') return { success: false, errorMessage: 'Allow this website in Website Access before connecting.' }
	const connectedTab = await browser.tabs.get(tab.id)
	if (connectedTab.url === undefined || new URL(connectedTab.url).origin !== origin) return { success: false, errorMessage: 'The website navigated during connection.' }
	if (operation.abort.signal.aborted) return cancelledReply(operation)
	await browser.tabs.reload(tab.id)
	return { success: true }
}

type PreparationOperation = {
	readonly abort: AbortController
	readonly cancelled: Promise<undefined>
	tabId?: number
	documentId?: string
	cleanup?: Promise<void>
}
const preparations = new Map<string, PreparationOperation>()
const cancelledReply = (operation: PreparationOperation): PrepareSafeAppReply['data'] => ({ success: false, errorMessage: typeof operation.abort.signal.reason === 'string' ? operation.abort.signal.reason : 'Safe connection was cancelled.' })
const isMissingPreparationDocument = (error: unknown) => isMissingBrowserTargetError(error) || error instanceof Error && (error.message.startsWith('No document with id') || error.message === 'The tab was closed.' || error.message === 'The frame was removed.' || /^Frame with ID \d+ was removed\./.test(error.message))

export async function prepareSafeAppTab(value: string): Promise<PrepareSafeAppReply['data']> {
	const origin = parseSafeAppsHostOrigin(value)
	if (preparations.has(origin)) return { success: false, errorMessage: 'A connection preparation is already running for this website. Cancel it before retrying.' }
	const abort = new AbortController()
	const operation: PreparationOperation = { abort, cancelled: new Promise((resolve) => abort.signal.addEventListener('abort', () => resolve(undefined), { once: true })) }
	preparations.set(origin, operation)
	const onRemoved = (tabId: number) => {
		if (operation.tabId === tabId) abort.abort('The website tab was closed. Reopen it before connecting.')
	}
	browser.tabs.onRemoved.addListener(onRemoved)
	try {
		return await prepareSafeAppTabOperation(origin, operation)
	} catch (error: unknown) {
		if (abort.signal.aborted) return cancelledReply(operation)
		if (isMissingPreparationDocument(error)) return { success: false, errorMessage: 'The website tab closed or navigated. Reopen it before connecting.' }
		throw error
	} finally {
		browser.tabs.onRemoved.removeListener(onRemoved)
		try { await operation.cleanup } finally { preparations.delete(origin) }
	}
}

export async function cancelSafeAppPreparation(value: string) {
	const origin = parseSafeAppsHostOrigin(value)
	const operation = preparations.get(origin)
	if (operation === undefined) return
	// Keep the operation reserved until page cleanup finishes; a late cancellation must not cancel a subsequent retry.
	operation.cleanup ??= clearPreparationScript(operation)
	operation.abort.abort('Safe connection was cancelled.')
	await operation.cleanup
}

async function clearPreparationScript(operation: PreparationOperation) {
	if (operation.tabId === undefined || operation.documentId === undefined) return
	const injectFiles = getChromeFileInjector()
	if (injectFiles === undefined) return
	try {
		await injectFiles({ target: { tabId: operation.tabId, documentIds: [operation.documentId] }, world: 'MAIN', files: ['/inpage/js/cancelSafeAppPreparationBootstrap.js'] })
	} catch (error: unknown) {
		if (!isMissingPreparationDocument(error)) throw error
	}
}
