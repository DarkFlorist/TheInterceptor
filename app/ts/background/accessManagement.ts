import { getActiveAddress, getActiveAddressesForAllTabs, sendPopupMessageToOpenWindows, websiteSocketToString } from './backgroundUtils.js'
import { getActiveAddressEntry, getActiveAddresses } from './metadataUtils.js'
import { requestAccessFromUser } from './windows/interceptorAccess.js'
import { retrieveWebsiteDetails, updateExtensionIcon } from './iconHandler.js'
import type { TabConnection, WebsiteTabConnections } from '../types/user-interface-types.js'
import type { InpageScriptCallBack, Settings } from '../types/interceptor-messages.js'
import { getSettings, getWebsiteAccess, updateWebsiteAccess } from './settings.js'
import { sendSubscriptionReplyOrCallBack } from './messageSending.js'
import { type WebsiteSocket, getHostWithPort } from '../utils/requests.js'
import { getAllTabStates } from './storageVariables.js'
import type { Website, WebsiteAccessArray, WebsiteAddressAccess } from '../types/websiteAccessTypes.js'
import { getUniqueItemsByProperties } from '../utils/typed-arrays.js'
import type { AddressBookEntries, AddressBookEntry } from '../types/addressBookTypes.js'
import { Semaphore } from '../utils/semaphore.js'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { TokenPriceService } from '../simulation/services/priceEstimator.js'
import type { ResetSimulationServices } from '../simulation/serviceLifecycle.js'
import { reportUnexpectedError } from '../utils/errors.js'
import { bumpPopupRefreshGeneration } from './popupRefreshGeneration.js'
import { getActiveAddressForCurrentSignerState } from './signerStateOwnership.js'
import { getLegacyWebsiteOriginForCanonicalOrigin, getWebsiteHostWithPortFromStoredOrigin } from './websiteAccessMigration.js'
import { applyInterceptorDisabledDecision, applyWebsiteAccessDecision } from './websiteAccessDecision.js'

function getConnectionDetails(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket) {
	const identifier = websiteSocketToString(socket)
	const tabConnection = websiteTabConnections.get(socket.tabId)
	return tabConnection?.connections[identifier]
}

function setWebsitePortApproval(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, approved: boolean, approvedAddress?: bigint) {
	const connection = getConnectionDetails(websiteTabConnections, socket)
	if (connection === undefined) return
	if (approved) connection.wantsToConnect = true
	connection.approved = approved
	connection.approvedAddress = approved ? approvedAddress : undefined
}

export function clearWebsiteConnectionIntent(websiteTabConnections: WebsiteTabConnections, websiteOrigin: string) {
	for (const [_tabId, tabConnection] of websiteTabConnections.entries()) {
		for (const key in tabConnection.connections) {
			const connection = tabConnection.connections[key]
			if (connection === undefined) throw new Error('missing connection')
			if (connection.websiteOrigin !== websiteOrigin) continue
			connection.wantsToConnect = false
		}
	}
}

const unscopedConnectionEventSuppressionCounts = new Map<string, number>()

function incrementUnscopedConnectionEventSuppression(socket: WebsiteSocket) {
	const socketIdentifier = websiteSocketToString(socket)
	unscopedConnectionEventSuppressionCounts.set(socketIdentifier, (unscopedConnectionEventSuppressionCounts.get(socketIdentifier) ?? 0) + 1)
	return socketIdentifier
}

function decrementUnscopedConnectionEventSuppression(socketIdentifier: string) {
	const previousCount = unscopedConnectionEventSuppressionCounts.get(socketIdentifier)
	if (previousCount === undefined || previousCount <= 1) {
		unscopedConnectionEventSuppressionCounts.delete(socketIdentifier)
		return
	}
	unscopedConnectionEventSuppressionCounts.set(socketIdentifier, previousCount - 1)
}

function shouldSendUnscopedConnectionEvents(socket: WebsiteSocket) {
	return !unscopedConnectionEventSuppressionCounts.has(websiteSocketToString(socket))
}

export function withSuppressedUnscopedConnectionEventsForSocket<T>(socket: WebsiteSocket, action: () => T): T {
	const socketIdentifier = incrementUnscopedConnectionEventSuppression(socket)
	try {
		return action()
	} finally {
		decrementUnscopedConnectionEventSuppression(socketIdentifier)
	}
}

export async function withSuppressedUnscopedConnectionEventsForSocketAsync<T>(socket: WebsiteSocket, action: () => Promise<T>): Promise<T> {
	const socketIdentifier = incrementUnscopedConnectionEventSuppression(socket)
	try {
		return await action()
	} finally {
		decrementUnscopedConnectionEventSuppression(socketIdentifier)
	}
}

export type ApprovalState = 'hasAccess' | 'noAccess' | 'askAccess' | 'interceptorDisabled'

function getExactAndLegacyWebsiteAccess(websiteAccess: WebsiteAccessArray, websiteOrigin: string) {
	const exactAccess = websiteAccess.find((entry) => entry.website.websiteOrigin === websiteOrigin)
	const legacyWebsiteOrigin = getLegacyWebsiteOriginForCanonicalOrigin(websiteOrigin)
	const legacyAccess = legacyWebsiteOrigin === undefined
		? undefined
		: websiteAccess.find((entry) => entry.website.websiteOrigin === legacyWebsiteOrigin)
	return { exactAccess, legacyAccess }
}

export function verifyAccess(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, askAccessIfUnknown: boolean, websiteOrigin: string, requestAccessForAddress: AddressBookEntry | undefined, settings: Settings, ignoreConnectionApproval = false) {
	const connection = getConnectionDetails(websiteTabConnections, socket)
	if (connection?.approved && !ignoreConnectionApproval
		&& (requestAccessForAddress === undefined || connection.approvedAddress === requestAccessForAddress.address)) return 'hasAccess'
	const access = requestAccessForAddress !== undefined ? hasAddressAccess(settings.websiteAccess, websiteOrigin, requestAccessForAddress) : hasAccess(settings.websiteAccess, websiteOrigin)
	if (access === 'hasAccess') {
		const popupRefreshGeneration = bumpPopupRefreshGeneration()
		connectToPort(
			websiteTabConnections,
			socket,
			settings,
			requestAccessForAddress?.address,
		)
		void updateExtensionIcon(websiteTabConnections, socket.tabId, websiteOrigin, popupRefreshGeneration).catch((error: unknown) => {
			void reportUnexpectedError(error)
		})
		return 'hasAccess'
	}
	if (access === 'noAccess' || access === 'interceptorDisabled') return access
	return askAccessIfUnknown ? 'askAccess' : 'noAccess'
}

export function sendMessageToApprovedWebsitePorts(websiteTabConnections: WebsiteTabConnections, message: InpageScriptCallBack) {
	// inform all the tabs about the address change
	for (const [_tab, tabConnection] of websiteTabConnections.entries() ) {
		for (const key in tabConnection.connections) {
			const connection = tabConnection.connections[key]
			if (connection === undefined) throw new Error('missing connection')
			if (!connection.approved) continue
			sendSubscriptionReplyOrCallBack(websiteTabConnections, connection.socket, { type: 'result' as const, ...message })
		}
	}
}
export async function sendActiveAccountChangeToApprovedWebsitePorts(websiteTabConnections: WebsiteTabConnections, settings: Settings) {
	// inform all the tabs about the address change
	for (const [_tab, tabConnection] of websiteTabConnections.entries() ) {
		for (const key in tabConnection.connections) {
			const connection = tabConnection.connections[key]
			if (connection === undefined) throw new Error('missing connection')
			if (!connection.approved) continue
			if (!shouldSendUnscopedConnectionEvents(connection.socket)) continue
			const activeAddress = await getActiveAddressForDomain(websiteTabConnections, connection.websiteOrigin, settings, connection.socket)
			sendSubscriptionReplyOrCallBack(websiteTabConnections, connection.socket, {
				type: 'result' as const,
				method: 'accountsChanged',
				result: activeAddress !== undefined ? [activeAddress.address] : []
			})
		}
	}
}

export function hasAccess(websiteAccess: WebsiteAccessArray, websiteOrigin: string) : ApprovalState {
	const { exactAccess, legacyAccess } = getExactAndLegacyWebsiteAccess(websiteAccess, websiteOrigin)
	if (exactAccess?.interceptorDisabled === true || legacyAccess?.interceptorDisabled === true) return 'interceptorDisabled'
	if (exactAccess?.access === true) return 'hasAccess'
	// Legacy grants are scheme-ambiguous, but applying a legacy denial to both
	// schemes cannot expose an account that the user did not authorize.
	if (exactAccess?.access === false || legacyAccess?.access === false) return 'noAccess'
	return 'askAccess'
}

export function hasAddressAccess(websiteAccess: WebsiteAccessArray, websiteOrigin: string, address: AddressBookEntry) : ApprovalState {
	const { exactAccess, legacyAccess } = getExactAndLegacyWebsiteAccess(websiteAccess, websiteOrigin)
	if (exactAccess?.interceptorDisabled === true || legacyAccess?.interceptorDisabled === true) return 'interceptorDisabled'
	if (exactAccess?.access === false) return 'noAccess'
	if (exactAccess?.access === true) {
		if (exactAccess.addressAccess !== undefined) {
			for (const addressAccess of exactAccess.addressAccess) {
				if (addressAccess.address === address.address) {
					return addressAccess.access ? 'hasAccess' : 'noAccess'
				}
			}
		}
		if (legacyAccess?.addressAccess?.some((entry) => entry.address === address.address && entry.access === false) === true) return 'noAccess'
		if (address.askForAddressAccess === false) return 'hasAccess'
		return 'askAccess'
	}
	if (legacyAccess?.access === false) return 'noAccess'
	if (legacyAccess?.addressAccess?.some((entry) => entry.address === address.address && entry.access === false) === true) return 'noAccess'
	return 'askAccess'
}

function getAddressAccesses(websiteAccess: WebsiteAccessArray, websiteOrigin: string) : readonly WebsiteAddressAccess[] {
	for (const web of websiteAccess) {
		if (web.website.websiteOrigin === websiteOrigin) {
			return web.addressAccess === undefined ? [] : web.addressAccess
		}
	}
	return []
}
function getAddressesThatDoNotNeedIndividualAccesses(activeAddressEntries: AddressBookEntries) : AddressBookEntries {
	return activeAddressEntries.filter((x) => x.askForAddressAccess === false)
}

export async function setInterceptorDisabledForWebsite(website: Website, interceptorDisabled: boolean) {
	return await updateWebsiteAccess((previousWebsiteAccess) => applyInterceptorDisabledDecision(previousWebsiteAccess, website, interceptorDisabled))
}

export async function setAccess(website: Website, access: boolean, address: bigint | undefined) {
	return await updateWebsiteAccess((previousWebsiteAccess) => applyWebsiteAccessDecision(previousWebsiteAccess, website, access, address))
}

// gets active address if the website has been give access for it, otherwise returns undefined
// this is to guard websites from seeing addresses without access
async function getActiveAddressForDomain(websiteTabConnections: WebsiteTabConnections, websiteOrigin: string, settings: Settings, socket: WebsiteSocket) {
	const activeAddress = await getActiveAddressForCurrentSignerState(websiteTabConnections, settings, socket.tabId, async () => await getActiveAddress(settings, socket.tabId))
	if (activeAddress === undefined) return undefined
	const hasAccess = hasAddressAccess(settings.websiteAccess, websiteOrigin, activeAddress)
	if (hasAccess === 'hasAccess') return activeAddress
	return undefined
}

function connectToPort(
	websiteTabConnections: WebsiteTabConnections,
	socket: WebsiteSocket,
	settings: Settings,
	connectWithActiveAddress: bigint | undefined,
): true {
	setWebsitePortApproval(websiteTabConnections, socket, true, connectWithActiveAddress)
	if (!shouldSendUnscopedConnectionEvents(socket)) return true
	sendProviderConnectionEventsToPort(websiteTabConnections, socket, settings, connectWithActiveAddress === undefined ? [] : [connectWithActiveAddress])
	return true
}

export function sendProviderConnectionEventsToPort(
	websiteTabConnections: WebsiteTabConnections,
	socket: WebsiteSocket,
	settings: Settings,
	accounts: readonly bigint[],
	options: { readonly requestId?: number, readonly includeChainChanged?: boolean } = {},
) {
	const requestScope = options.requestId === undefined ? {} : { requestId: options.requestId }
	sendSubscriptionReplyOrCallBack(websiteTabConnections, socket, { type: 'result' as const, method: 'connect', result: [settings.activeRpcNetwork.chainId], ...requestScope })
	sendSubscriptionReplyOrCallBack(websiteTabConnections, socket, { type: 'result' as const, method: 'accountsChanged', result: accounts, ...requestScope })
	if (options.includeChainChanged === false) return
	sendSubscriptionReplyOrCallBack(websiteTabConnections, socket, { type: 'result' as const, method: 'chainChanged', result: settings.activeRpcNetwork.chainId, ...requestScope })
}

function disconnectFromPort(
	websiteTabConnections: WebsiteTabConnections,
	socket: WebsiteSocket,
): false {
	setWebsitePortApproval(websiteTabConnections, socket, false)
	// Account access can be revoked without the provider losing chain connectivity.
	// Notify account listeners before the legacy disconnect event so dapps clear stale account state.
	sendSubscriptionReplyOrCallBack(websiteTabConnections, socket, { type: 'result' as const, method: 'accountsChanged', result: [] })
	sendSubscriptionReplyOrCallBack(websiteTabConnections, socket, { type: 'result' as const, method: 'disconnect', result: [] })
	return false
}

export function suspendWebsitePortApprovalsForTab(websiteTabConnections: WebsiteTabConnections, tabId: number) {
	const tabConnection = websiteTabConnections.get(tabId)
	if (tabConnection === undefined) return
	for (const connection of Object.values(tabConnection.connections)) {
		if (!connection.approved) continue
		disconnectFromPort(websiteTabConnections, connection.socket)
	}
}

export async function getAssociatedAddresses(settings: Settings, websiteOrigin: string, activeAddress: AddressBookEntry | undefined) : Promise<AddressBookEntries> {
	const addressAccess = await Promise.all(getAddressAccesses(settings.websiteAccess, websiteOrigin).filter((x) => x.access).map((x) => x.address).map((x) => getActiveAddressEntry(x)))
	const allAccessAddresses = getAddressesThatDoNotNeedIndividualAccesses(await getActiveAddresses())
	const all = allAccessAddresses.concat(addressAccess).concat(activeAddress === undefined ? [] : [activeAddress])
	return getUniqueItemsByProperties(all, ['address'])
}

async function askUserForAccessOnConnectionUpdate(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, resetSimulationServices: ResetSimulationServices, websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, websiteOrigin: string, activeAddress: AddressBookEntry | undefined, settings: Settings) {
	const details = getConnectionDetails(websiteTabConnections, socket)
	if (details === undefined) return

	const website = { websiteOrigin, ...await retrieveWebsiteDetails(socket.tabId, websiteOrigin) }
	await requestAccessFromUser(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, socket, website, undefined, activeAddress, settings, activeAddress?.address, undefined)
}

function addIconRefreshTarget(iconRefreshTargets: Map<string, { tabId: number, websiteOrigin: string }>, tabId: number, websiteOrigin: string) {
	const key = `${ tabId }-${ websiteOrigin }`
	if (iconRefreshTargets.has(key)) return
	iconRefreshTargets.set(key, { tabId, websiteOrigin })
}

async function updateTabConnections(
	ethereum: EthereumClientService | undefined,
	tokenPriceService: TokenPriceService | undefined,
	resetSimulationServices: ResetSimulationServices | undefined,
	websiteTabConnections: WebsiteTabConnections,
	tabConnection: TabConnection,
	promptForAccessesIfNeeded: boolean,
	settings: Settings,
): Promise<Map<string, { tabId: number, websiteOrigin: string }>> {
	const iconRefreshTargets = new Map<string, { tabId: number, websiteOrigin: string }>()
	for (const key in tabConnection.connections) {
		const connection = tabConnection.connections[key]
		if (connection === undefined) throw new Error('missing connection')
		const currentActiveAddress = await getActiveAddressForCurrentSignerState(
			websiteTabConnections,
			settings,
			connection.socket.tabId,
			async () => await getActiveAddress(settings, connection.socket.tabId),
		)
		addIconRefreshTarget(iconRefreshTargets, connection.socket.tabId, connection.websiteOrigin)
		const access = currentActiveAddress ? hasAddressAccess(settings.websiteAccess, connection.websiteOrigin, currentActiveAddress) : hasAccess(settings.websiteAccess, connection.websiteOrigin)

		if (access !== 'hasAccess' && connection.approved) {
			disconnectFromPort(websiteTabConnections, connection.socket)
		} else if (access === 'hasAccess' && !connection.approved) {
			connectToPort(websiteTabConnections, connection.socket, settings, currentActiveAddress?.address)
		}

		if (access === 'askAccess' && connection.wantsToConnect && promptForAccessesIfNeeded && ethereum !== undefined && tokenPriceService !== undefined && resetSimulationServices !== undefined) {
			const activeAddress = currentActiveAddress !== undefined ? currentActiveAddress : undefined
			await askUserForAccessOnConnectionUpdate(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, connection.socket, connection.websiteOrigin, activeAddress, settings)
		}
	}
	return iconRefreshTargets
}

const getApprovedTabs = (websiteTabConnections: WebsiteTabConnections) => {
	const approvedTabs = new Set<number>()
	for (const [tab, tabConnection] of websiteTabConnections.entries()) {
		for (const key in tabConnection.connections) {
			const connection = tabConnection.connections[key]
			if (connection?.approved) {
				approvedTabs.add(tab)
				continue
			}
		}
	}
	return approvedTabs
}
const getTabsAndAddressesToBlock = async (websiteTabConnections: WebsiteTabConnections) => {
	const approvedTabIds = getApprovedTabs(websiteTabConnections)
	const tabIdsToBlock = (await getActiveAddressesForAllTabs(await getSettings())).filter((tabData) => approvedTabIds.has(tabData.tabId)).filter((tabData) => tabData.activeAddress?.declarativeNetRequestBlockMode === 'block-all').map((tabData) => tabData.tabId)
	const sitesToBlock = (await getWebsiteAccess())
		.filter((access) => access.declarativeNetRequestBlockMode === 'block-all')
		.flatMap((access) => {
			const host = getWebsiteHostWithPortFromStoredOrigin(access.website.websiteOrigin)
			return host === undefined ? [] : [host]
		})
	return {
		tabIdsToBlock,
		sitesToBlock
	}
}

let webRequestListener: (details: browser.webRequest._OnBeforeRequestDetails) => void = () => undefined
let previousDecralativeNetRequestBlockIdentifier = ''
const updateDeclarativeNetRequestBlocksSemaphore = new Semaphore(1)
export async function updateDeclarativeNetRequestBlocks(websiteTabConnections: WebsiteTabConnections) {
	return await updateDeclarativeNetRequestBlocksSemaphore.execute(async () => {
		const { tabIdsToBlock, sitesToBlock } = await getTabsAndAddressesToBlock(websiteTabConnections)
		// check if the rules would change, if not, just bail out
		const decralativeNetRequestBlockIdentifier = `${ tabIdsToBlock.join('|') }|a|${ sitesToBlock.join('|') }`
		if (decralativeNetRequestBlockIdentifier === previousDecralativeNetRequestBlockIdentifier) return
		previousDecralativeNetRequestBlockIdentifier = decralativeNetRequestBlockIdentifier

		if (browser.runtime.getManifest().manifest_version === 3) {
			const dynamicRuleIds = (await browser.declarativeNetRequest.getDynamicRules()).map((rule) => rule.id)
			const sessionRuleIds = (await browser.declarativeNetRequest.getSessionRules()).map((rule) => rule.id)
			if (sitesToBlock.length !== 0) {
				await browser.declarativeNetRequest.updateDynamicRules({
					removeRuleIds: dynamicRuleIds,
					addRules: [{
						id: dynamicRuleIds.length === 0 ? 1 : Math.max.apply(null, dynamicRuleIds) + 1,
						priority: 1,
						action : { type: 'block' as const },
						condition: { initiatorDomains: sitesToBlock, domainType: 'thirdParty' as const }
					}]
				})
			} else {
				await browser.declarativeNetRequest.updateDynamicRules({ removeRuleIds: dynamicRuleIds })
			}
			if (tabIdsToBlock.length !== 0) {
				await browser.declarativeNetRequest.updateSessionRules({
					removeRuleIds: sessionRuleIds,
					addRules: [{
						id: sessionRuleIds.length === 0 ? 1 : Math.max.apply(null, sessionRuleIds) + 1,
						priority: 2,
						action : { type: 'block' as const },
						condition: { tabIds: tabIdsToBlock, domainType: 'thirdParty' as const }
					}]
				})
			} else {
				await browser.declarativeNetRequest.updateSessionRules({ removeRuleIds: sessionRuleIds })
			}
			// enable `declarativeNetRequestFeedback` permission to manifest and uncomment to enable debugging
			// const a = (data: any) => { console.log(data) }
			// (browser.declarativeNetRequest as any).onRuleMatchedDebug.addListener(a)
		} else {
			browser.webRequest.onBeforeRequest.removeListener(webRequestListener)
			webRequestListener = (details: browser.webRequest._OnBeforeRequestDetails) => {
				if (tabIdsToBlock.find((tabId) => tabId === details.tabId) !== undefined) return { cancel: true }
				if (details.originUrl === undefined) return {}
				if (details.type === 'main_frame') return {}
				const websiteOrigin = getHostWithPort(details.originUrl)
				const destinationHost = getHostWithPort(details.url)
				if (destinationHost === websiteOrigin) return {}
				if (sitesToBlock.find((blockUrl) => blockUrl === websiteOrigin) !== undefined) return { cancel: true }
				return {}
			}
			if (sitesToBlock.length === 0 && tabIdsToBlock.length === 0) return
			browser.webRequest.onBeforeRequest.addListener(webRequestListener, { urls: ['<all_urls>'] }, ['blocking'])
		}
	})
}

export const areWeBlocking = async (websiteTabConnections: WebsiteTabConnections, tabId: number, websiteOrigin: string) => {
	const { tabIdsToBlock, sitesToBlock } = await getTabsAndAddressesToBlock(websiteTabConnections)
	if (sitesToBlock.find((blockUrl) => blockUrl === getHostWithPort(websiteOrigin)) !== undefined) return true
	if (tabIdsToBlock.find((blockTab) => blockTab === tabId) !== undefined) return true
	return false
}

export async function updateWebsiteApprovalAccesses(
	ethereum: EthereumClientService | undefined,
	tokenPriceService: TokenPriceService | undefined,
	resetSimulationServices: ResetSimulationServices | undefined,
	websiteTabConnections: WebsiteTabConnections,
	settings: Settings,
	promptForAccessesIfNeeded: boolean,
): Promise<number> {
	const popupRefreshGeneration = bumpPopupRefreshGeneration()
	const allTabStates = await getAllTabStates()
	const iconRefreshTargets = new Map<string, { tabId: number, websiteOrigin: string }>()

	try {
		await updateDeclarativeNetRequestBlocks(websiteTabConnections)
	} catch (error) {
		await reportUnexpectedError(error)
	}
	// update port connections and disconnect from ports that should not have access anymore
	const updatePromises = [...websiteTabConnections.entries()].map(async ([_tab, tabConnection]) => {
		const tabIconRefreshTargets = await updateTabConnections(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, tabConnection, promptForAccessesIfNeeded, settings)
		for (const iconRefreshTarget of tabIconRefreshTargets.values()) addIconRefreshTarget(iconRefreshTargets, iconRefreshTarget.tabId, iconRefreshTarget.websiteOrigin)
	})
	for (const tabState of allTabStates) {
		if (websiteTabConnections.has(tabState.tabId)) continue
		if (tabState.website?.websiteOrigin === undefined) continue
		addIconRefreshTarget(iconRefreshTargets, tabState.tabId, tabState.website.websiteOrigin)
	}
	try {
		await Promise.all(updatePromises)
	} catch (error) {
		await reportUnexpectedError(error)
	}
	const iconRefreshPromises = [...iconRefreshTargets.values()].map(({ tabId, websiteOrigin }) =>
		updateExtensionIcon(websiteTabConnections, tabId, websiteOrigin, popupRefreshGeneration)
	)
	try {
		await Promise.all(iconRefreshPromises)
	} catch (error) {
		await reportUnexpectedError(error)
	}
	return popupRefreshGeneration
}

export async function persistWebsiteAccessChange(
	ethereum: EthereumClientService | undefined,
	tokenPriceService: TokenPriceService | undefined,
	resetSimulationServices: ResetSimulationServices | undefined,
	websiteTabConnections: WebsiteTabConnections,
	website: Website,
	access: boolean,
	address: bigint | undefined,
	promptForAccessesIfNeeded: boolean,
): Promise<Settings> {
	await setAccess(website, access, address)
	const refreshedSettings = await getSettings()
	await updateWebsiteApprovalAccesses(
		ethereum,
		tokenPriceService,
		resetSimulationServices,
		websiteTabConnections,
		refreshedSettings,
		promptForAccessesIfNeeded,
	)
	await sendPopupMessageToOpenWindows({ method: 'popup_websiteAccess_changed' })
	return refreshedSettings
}
