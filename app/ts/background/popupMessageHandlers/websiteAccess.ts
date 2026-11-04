import type { SimulationServicesOwner } from '../../simulation/serviceLifecycle.js'
import type { AllowOrPreventAddressAccessForWebsite, BlockOrAllowExternalRequests, DisableInterceptor, RemoveWebsiteAccess, RemoveWebsiteAddressAccess, RetrieveWebsiteAccess } from '../../types/interceptor-messages.js'
import type { EthereumAddress } from '../../types/wire-types.js'
import type { Website } from '../../types/websiteAccessTypes.js'
import { getErrorMessage, reportUnexpectedError } from '../../utils/errors.js'
import { checkAndThrowRuntimeLastError } from '../../utils/requests.js'
import { updateContentScriptInjectionStrategy } from '../../utils/contentScriptsUpdating.js'
import { modifyObject } from '../../utils/typescript.js'
import { setInterceptorDisabledForWebsite, updateWebsiteApprovalAccesses } from '../accessManagement.js'
import { sendPopupMessageToOpenWindows } from '../backgroundUtils.js'
import { getLastKnownCurrentTabId } from '../currentTab.js'
import { getSettings, updateWebsiteAccess } from '../settings.js'
import type { WebsiteTabConnections } from '../../types/user-interface-types.js'
import { getAddressMetadataForAccess } from '../windows/interceptorAccess.js'
import { searchWebsiteAccess } from '../websiteAccessSearch.js'
import { updateWebsiteAccessAndDetectDisabledSitesChange } from '../websiteAccessUpdating.js'

const isMissingTabReloadError = (error: unknown) => {
	const message = getErrorMessage(error)
	return message !== undefined && (message.startsWith('No tab with id') || message.includes('Invalid tab ID'))
}

// A failed current-tab lookup is handled like a per-tab reload failure: reported, not thrown. That is safe because the connected tabs still reload and reconciliation still runs, and missing the current tab is the same outcome as one failed tab reload. runStepsThenReconcileApprovals rethrows only failures that escape reloadConnectedTabs.
const getCurrentTabIdToReload = async () => {
	try {
		return await getLastKnownCurrentTabId()
	} catch (error) {
		await reportUnexpectedError(error, { code: 'connected_tab_reload_current_tab_lookup_failed' })
		return undefined
	}
}

export async function reloadConnectedTabs(websiteTabConnections: WebsiteTabConnections) {
	const tabIdsToRefresh = Array.from(websiteTabConnections.keys())
	const currentTabId = await getCurrentTabIdToReload()
	const withCurrentTabId = currentTabId === undefined ? tabIdsToRefresh : [...tabIdsToRefresh, currentTabId]
	for (const tabId of new Set(withCurrentTabId)) {
		try {
			await browser.tabs.reload(tabId)
			checkAndThrowRuntimeLastError()
		} catch (error) {
			if (isMissingTabReloadError(error)) continue
			await reportUnexpectedError(error, { code: 'connected_tab_reload_failed' })
		}
	}
}

type WebsiteAccessFollowUpStep = { readonly name: string, readonly run: () => Promise<void> }
type StepFailure = { readonly name: string, readonly error: unknown }

export const updateContentScriptInjectionStep: WebsiteAccessFollowUpStep = {
	name: 'updating the content script injection',
	run: async () => await updateContentScriptInjectionStrategy(),
}

export const reloadConnectedTabsStep = (websiteTabConnections: WebsiteTabConnections): WebsiteAccessFollowUpStep => ({
	name: 'reloading connected tabs',
	run: async () => await reloadConnectedTabs(websiteTabConnections),
})

// The message names every failure because reports keep only the outer message, e.g. "Reloading connected tabs failed (a) and reconciling website approvals failed (b)".
function describeStepFailures(failures: readonly StepFailure[]) {
	const sentence = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' }).format(failures.map(({ name, error }) => `${ name } failed (${ getErrorMessage(error) ?? 'unknown error' })`))
	return `${ sentence.charAt(0).toUpperCase() }${ sentence.slice(1) }`
}

// Call this once a website-access change is saved. Steps run in order and a failing step does not stop the later ones, so the saved change always reaches open connections. Reload before reconciling so outgoing pages drop their connections before reconciliation can re-prompt them. One failure is rethrown as is; several are thrown together in step order so none hides another.
export async function runStepsThenReconcileApprovals(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, stepsBeforeReconciliation: readonly WebsiteAccessFollowUpStep[]) {
	const reconcileApprovalsStep: WebsiteAccessFollowUpStep = {
		name: 'reconciling website approvals',
		run: async () => { await updateWebsiteApprovalAccesses(simulationServicesOwner, websiteTabConnections, await getSettings(), true) },
	}
	const failures: StepFailure[] = []
	for (const step of [...stepsBeforeReconciliation, reconcileApprovalsStep]) {
		try {
			await step.run()
		} catch (error) {
			failures.push({ name: step.name, error })
		}
	}
	const [firstFailure, ...laterFailures] = failures
	if (firstFailure === undefined) return
	if (laterFailures.length === 0) throw firstFailure.error
	throw new AggregateError(failures.map(({ error }) => error), describeStepFailures(failures))
}

export async function disableInterceptor(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, parsedRequest: DisableInterceptor) {
	const disabledSitesChanged = await setInterceptorDisabledForWebsite(parsedRequest.data.website, parsedRequest.data.interceptorDisabled)
	await runStepsThenReconcileApprovals(simulationServicesOwner, websiteTabConnections, [
		...(disabledSitesChanged ? [updateContentScriptInjectionStep] : []),
		reloadConnectedTabsStep(websiteTabConnections),
	])
	await sendPopupMessageToOpenWindows({ method: 'popup_setDisableInterceptorReply' as const, data: parsedRequest.data })
}

export async function retrieveWebsiteAccess(parsedRequest: RetrieveWebsiteAccess) {
	const settings = await getSettings()
	const websiteAccess = searchWebsiteAccess(parsedRequest.data.query, settings.websiteAccess)
	const addressAccessMetadata = await getAddressMetadataForAccess(websiteAccess, settings.activeRpcNetwork.chainId)
	await sendPopupMessageToOpenWindows({ method: 'popup_retrieveWebsiteAccessReply', data: { websiteAccess, addressAccessMetadata } })
}

const blockOrAllowWebsiteExternalRequests = async (website: Website, shouldBlock: boolean) => {
	await updateWebsiteAccess((previousAccessList) => previousAccessList.map((access) => {
		if (access.website.websiteOrigin !== website.websiteOrigin) return access
		return modifyObject(access, { declarativeNetRequestBlockMode: shouldBlock ? 'block-all' : 'disabled' })
	}))
}

export async function blockOrAllowExternalRequests(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, parsedRequest: BlockOrAllowExternalRequests) {
	await blockOrAllowWebsiteExternalRequests(parsedRequest.data.website, parsedRequest.data.shouldBlock)
	await runStepsThenReconcileApprovals(simulationServicesOwner, websiteTabConnections, [reloadConnectedTabsStep(websiteTabConnections)])
	await sendPopupMessageToOpenWindows({ method: 'popup_websiteAccess_changed' })
}

const removeAddressAccessByAddress = async (websiteOrigin: string, address: EthereumAddress) => {
	await updateWebsiteAccess((previousAccessList) => previousAccessList.map((access) => {
		if (access.website.websiteOrigin !== websiteOrigin || !access.addressAccess) return access
		return modifyObject(access, { addressAccess: access.addressAccess.filter((addressAccess) => addressAccess.address !== address) })
	}))
}

export async function removeWebsiteAddressAccess(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, parsedRequest: RemoveWebsiteAddressAccess) {
	await removeAddressAccessByAddress(parsedRequest.data.websiteOrigin, parsedRequest.data.address)
	await runStepsThenReconcileApprovals(simulationServicesOwner, websiteTabConnections, [reloadConnectedTabsStep(websiteTabConnections)])
	await sendPopupMessageToOpenWindows({ method: 'popup_websiteAccess_changed' })
}

const setAddressAccessForWebsite = async (websiteOrigin: string, address: EthereumAddress, allowAccess: boolean) => {
	await updateWebsiteAccess((previousAccessList) => previousAccessList.map((access) => {
		if (access.website.websiteOrigin !== websiteOrigin || access.addressAccess === undefined) return access
		const addressAccess = access.addressAccess.map((entry) => entry.address === address ? modifyObject(entry, { access: allowAccess }) : entry)
		return modifyObject(access, { addressAccess })
	}))
}

export async function allowOrPreventAddressAccessForWebsite(websiteTabConnections: WebsiteTabConnections, parsedRequest: AllowOrPreventAddressAccessForWebsite) {
	const { website, address, allowAccess } = parsedRequest.data
	await setAddressAccessForWebsite(website.websiteOrigin, address, allowAccess)
	await reloadConnectedTabs(websiteTabConnections)
	await sendPopupMessageToOpenWindows({ method: 'popup_websiteAccess_changed' })
}

export async function removeWebsiteAccess(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, parsedRequest: RemoveWebsiteAccess) {
	const disabledSitesChanged = await updateWebsiteAccessAndDetectDisabledSitesChange((previousAccess) => previousAccess.filter((access) => access.website.websiteOrigin !== parsedRequest.data.websiteOrigin))
	await runStepsThenReconcileApprovals(simulationServicesOwner, websiteTabConnections, disabledSitesChanged ? [updateContentScriptInjectionStep] : [])
	await sendPopupMessageToOpenWindows({ method: 'popup_websiteAccess_changed' })
}
