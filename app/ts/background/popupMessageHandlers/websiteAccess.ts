import type { SimulationServicesOwner } from '../../simulation/serviceLifecycle.js'
import type { AllowOrPreventAddressAccessForWebsite, BlockOrAllowExternalRequests, DisableInterceptor, RemoveWebsiteAccess, RemoveWebsiteAddressAccess, RetrieveWebsiteAccess } from '../../types/interceptor-messages.js'
import type { EthereumAddress } from '../../types/wire-types.js'
import type { Website, WebsiteAccessArray } from '../../types/websiteAccessTypes.js'
import { getErrorMessage, reportUnexpectedError } from '../../utils/errors.js'
import { checkAndThrowRuntimeLastError } from '../../utils/requests.js'
import { getInterceptorDisabledSites, updateContentScriptInjectionStrategy } from '../../utils/contentScriptsUpdating.js'
import { replaceElementInReadonlyArray } from '../../utils/typed-arrays.js'
import { modifyObject } from '../../utils/typescript.js'
import { updateWebsiteApprovalAccesses } from '../accessManagement.js'
import { sendPopupMessageToOpenWindows } from '../backgroundUtils.js'
import { getLastKnownCurrentTabId } from '../currentTab.js'
import { getSettings, updateWebsiteAccess } from '../settings.js'
import type { WebsiteTabConnections } from '../../types/user-interface-types.js'
import { getAddressMetadataForAccess } from '../windows/interceptorAccess.js'
import { searchWebsiteAccess } from '../websiteAccessSearch.js'

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
type WebsiteAccessUpdate = (previousWebsiteAccess: WebsiteAccessArray) => WebsiteAccessArray
type ConnectedTabsReloadPolicy = 'always' | 'whenDisabledSitesChange' | 'never'

const updateContentScriptInjectionStep: WebsiteAccessFollowUpStep = {
	name: 'updating the content script injection',
	run: async () => await updateContentScriptInjectionStrategy(),
}

const reloadConnectedTabsStep = (websiteTabConnections: WebsiteTabConnections): WebsiteAccessFollowUpStep => ({
	name: 'reloading connected tabs',
	run: async () => await reloadConnectedTabs(websiteTabConnections),
})

// The message names every failure because reports keep only the outer message, e.g. "Reloading connected tabs failed (a) and reconciling website approvals failed (b)".
function describeStepFailures(failures: readonly StepFailure[]) {
	const sentence = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' }).format(failures.map(({ name, error }) => `${ name } failed (${ getErrorMessage(error) ?? 'unknown error' })`))
	return `${ sentence.charAt(0).toUpperCase() }${ sentence.slice(1) }`
}

// Call this once a website-access change is saved. Steps run in order and a failing step does not stop the later ones, so the saved change always reaches open connections. Reload before reconciling so outgoing pages drop their connections before reconciliation can re-prompt them. One failure is rethrown as is; several are thrown together in step order so none hides another.
async function runStepsThenReconcileApprovals(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, stepsBeforeReconciliation: readonly WebsiteAccessFollowUpStep[]) {
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

function haveSameDisabledSites(previousWebsiteAccess: WebsiteAccessArray, nextWebsiteAccess: WebsiteAccessArray) {
	const previousDisabledSites = new Set(getInterceptorDisabledSites(previousWebsiteAccess))
	const nextDisabledSites = new Set(getInterceptorDisabledSites(nextWebsiteAccess))
	return previousDisabledSites.size === nextDisabledSites.size && [...previousDisabledSites].every((origin) => nextDisabledSites.has(origin))
}

// Detecting a disabled sites change and updating the content script injection stay together here, so a caller only states its update and reload policy and cannot leave the injection stale. A failed save throws with no follow-up because nothing was stored.
export async function applyWebsiteAccessUpdate(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, reloadPolicy: ConnectedTabsReloadPolicy, update: WebsiteAccessUpdate) {
	let disabledSitesChanged = false
	await updateWebsiteAccess((previousWebsiteAccess) => {
		const nextWebsiteAccess = update(previousWebsiteAccess)
		disabledSitesChanged = !haveSameDisabledSites(previousWebsiteAccess, nextWebsiteAccess)
		return nextWebsiteAccess
	})
	const shouldReloadConnectedTabs = reloadPolicy === 'always' || (reloadPolicy === 'whenDisabledSitesChange' && disabledSitesChanged)
	await runStepsThenReconcileApprovals(simulationServicesOwner, websiteTabConnections, [
		...(disabledSitesChanged ? [updateContentScriptInjectionStep] : []),
		...(shouldReloadConnectedTabs ? [reloadConnectedTabsStep(websiteTabConnections)] : []),
	])
}

const withInterceptorDisabledForWebsite = (website: Website, interceptorDisabled: boolean): WebsiteAccessUpdate => (previousWebsiteAccess) => {
	const index = previousWebsiteAccess.findIndex((entry) => entry.website.websiteOrigin === website.websiteOrigin)
	const previousAccess = index !== -1 ? previousWebsiteAccess[index] : undefined
	if (previousAccess === undefined) return [...previousWebsiteAccess, { website, addressAccess: [], interceptorDisabled }]
	return replaceElementInReadonlyArray(previousWebsiteAccess, index, { ...previousAccess, interceptorDisabled })
}

export async function disableInterceptor(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, parsedRequest: DisableInterceptor) {
	await applyWebsiteAccessUpdate(simulationServicesOwner, websiteTabConnections, 'always', withInterceptorDisabledForWebsite(parsedRequest.data.website, parsedRequest.data.interceptorDisabled))
	await sendPopupMessageToOpenWindows({ method: 'popup_setDisableInterceptorReply' as const, data: parsedRequest.data })
}

export async function retrieveWebsiteAccess(parsedRequest: RetrieveWebsiteAccess) {
	const settings = await getSettings()
	const websiteAccess = searchWebsiteAccess(parsedRequest.data.query, settings.websiteAccess)
	const addressAccessMetadata = await getAddressMetadataForAccess(websiteAccess, settings.activeRpcNetwork.chainId)
	await sendPopupMessageToOpenWindows({ method: 'popup_retrieveWebsiteAccessReply', data: { websiteAccess, addressAccessMetadata } })
}

const withExternalRequestsBlockedOrAllowed = (website: Website, shouldBlock: boolean): WebsiteAccessUpdate => (previousAccessList) => previousAccessList.map((access) => {
	if (access.website.websiteOrigin !== website.websiteOrigin) return access
	return modifyObject(access, { declarativeNetRequestBlockMode: shouldBlock ? 'block-all' : 'disabled' })
})

export async function blockOrAllowExternalRequests(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, parsedRequest: BlockOrAllowExternalRequests) {
	await applyWebsiteAccessUpdate(simulationServicesOwner, websiteTabConnections, 'always', withExternalRequestsBlockedOrAllowed(parsedRequest.data.website, parsedRequest.data.shouldBlock))
	await sendPopupMessageToOpenWindows({ method: 'popup_websiteAccess_changed' })
}

const withoutAddressAccess = (websiteOrigin: string, address: EthereumAddress): WebsiteAccessUpdate => (previousAccessList) => previousAccessList.map((access) => {
	if (access.website.websiteOrigin !== websiteOrigin || !access.addressAccess) return access
	return modifyObject(access, { addressAccess: access.addressAccess.filter((addressAccess) => addressAccess.address !== address) })
})

export async function removeWebsiteAddressAccess(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, parsedRequest: RemoveWebsiteAddressAccess) {
	await applyWebsiteAccessUpdate(simulationServicesOwner, websiteTabConnections, 'always', withoutAddressAccess(parsedRequest.data.websiteOrigin, parsedRequest.data.address))
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
	await applyWebsiteAccessUpdate(simulationServicesOwner, websiteTabConnections, 'never', (previousAccess) => previousAccess.filter((access) => access.website.websiteOrigin !== parsedRequest.data.websiteOrigin))
	await sendPopupMessageToOpenWindows({ method: 'popup_websiteAccess_changed' })
}
