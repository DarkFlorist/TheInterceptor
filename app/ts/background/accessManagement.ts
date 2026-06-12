import { getActiveAddress, getActiveAddressesForAllTabs, websiteSocketToString } from './backgroundUtils.js'
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
import { getUniqueItemsByProperties, replaceElementInReadonlyArray } from '../utils/typed-arrays.js'
import { modifyObject } from '../utils/typescript.js'
import type { AddressBookEntries, AddressBookEntry } from '../types/addressBookTypes.js'
import { Semaphore } from '../utils/semaphore.js'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { TokenPriceService } from '../simulation/services/priceEstimator.js'
import type { ResetSimulationServices } from '../simulation/serviceLifecycle.js'
import { mergeStoredWebsiteMetadata } from '../utils/websiteIcons.js'
import { handleUnexpectedError } from '../utils/errors.js'
import { bumpPopupRefreshGeneration } from './popupRefreshGeneration.js'

function getConnectionDetails(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket) {
	const identifier = websiteSocketToString(socket)
	const tabConnection = websiteTabConnections.get(socket.tabId)
	return tabConnection?.connections[identifier]
}

function setWebsitePortApproval(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, approved: boolean) {
	const connection = getConnectionDetails(websiteTabConnections, socket)
	if (connection === undefined) return
	if (approved) connection.wantsToConnect = true
	connection.approved = approved
}

export type ApprovalState = 'hasAccess' | 'noAccess' | 'askAccess' | 'interceptorDisabled' | 'notFound'

export function verifyAccess(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, askAccessIfUnknown: boolean, websiteOrigin: string, requestAccessForAddress: AddressBookEntry | undefined, settings: Settings) {
	const connection = getConnectionDetails(websiteTabConnections, socket)
	if (connection?.approved) return 'hasAccess'
	const access = requestAccessForAddress !== undefined ? hasAddressAccess(settings.websiteAccess, websiteOrigin, requestAccessForAddress) : hasAccess(settings.websiteAccess, websiteOrigin)
	if (access === 'hasAccess') {
		const popupRefreshGeneration = bumpPopupRefreshGeneration()
		connectToPort(
			websiteTabConnections,
			socket,
			settings,
			requestAccessForAddress?.address,
		)
		void updateExtensionIcon(websiteTabConnections, socket.tabId, websiteOrigin, popupRefreshGeneration)
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
			const activeAddress = await getActiveAddressForDomain(connection.websiteOrigin, settings, connection.socket)
			sendSubscriptionReplyOrCallBack(websiteTabConnections, connection.socket, {
				type: 'result' as const,
				method: 'accountsChanged',
				result: activeAddress !== undefined ? [activeAddress.address] : []
			})
		}
	}
}

export function hasAccess(websiteAccess: WebsiteAccessArray, websiteOrigin: string) : ApprovalState {
	for (const web of websiteAccess) {
		if (web.website.websiteOrigin === websiteOrigin) {
			if (web.interceptorDisabled) return 'interceptorDisabled'
			return web.access ? 'hasAccess' : 'noAccess'
		}
	}
	return 'notFound'
}

export function hasAddressAccess(websiteAccess: WebsiteAccessArray, websiteOrigin: string, address: AddressBookEntry) : ApprovalState {
	for (const web of websiteAccess) {
		if (web.website.websiteOrigin === websiteOrigin) {
			if (web.interceptorDisabled) return 'interceptorDisabled'
			if (!web.access) return 'noAccess'
			if (web.addressAccess !== undefined) {
				for (const addressAccess of web.addressAccess) {
					if (addressAccess.address === address.address) {
						return addressAccess.access ? 'hasAccess' : 'noAccess'
					}
				}
			}
			if (address.askForAddressAccess === false) return 'hasAccess'
			return 'notFound'
		}
	}
	return 'notFound'
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
	return await updateWebsiteAccess((previousWebsiteAccess) => {
		const index = previousWebsiteAccess.findIndex((entry) => entry.website.websiteOrigin === website.websiteOrigin)
		const previousAccess = index !== -1 ? previousWebsiteAccess[index] : undefined;
		if (previousAccess === undefined) return [...previousWebsiteAccess, { website, addressAccess: [], interceptorDisabled } ]
		return replaceElementInReadonlyArray(previousWebsiteAccess, index, { ...previousAccess, interceptorDisabled })
	})
}

export async function setAccess(website: Website, access: boolean, address: bigint | undefined) {
	return await updateWebsiteAccess((previousWebsiteAccess) => {
		const foundEntry = previousWebsiteAccess.find((entry) => entry.website.websiteOrigin === website.websiteOrigin)
		if (foundEntry === undefined) return [...previousWebsiteAccess, { website, access, addressAccess: address === undefined || !access ? undefined : [ { address, access } ] }]
		return previousWebsiteAccess.map((prevAccess) => {
			if (prevAccess.website.websiteOrigin === website.websiteOrigin) {
				const websiteData = mergeStoredWebsiteMetadata(prevAccess.website, website)
				if (address === undefined) return modifyObject(prevAccess, { website: websiteData, access })
				const addressAccess = { address, access }
				const updatedEntry = modifyObject(prevAccess, { website: websiteData, access: prevAccess.access ? prevAccess.access : access })
				if (prevAccess.addressAccess === undefined) return modifyObject(updatedEntry, { addressAccess: [addressAccess] })
				if (prevAccess.addressAccess.find((x) => x.address === address) === undefined) {
					return modifyObject(updatedEntry, { addressAccess: [ ...prevAccess.addressAccess, addressAccess ] })
				}
				return modifyObject(updatedEntry, { addressAccess: prevAccess.addressAccess.map((x) => (x.address === address ? addressAccess : x)) })
			}
			return prevAccess
		})
	})
}

// gets active address if the website has been give access for it, otherwise returns undefined
// this is to guard websites from seeing addresses without access
async function getActiveAddressForDomain(websiteOrigin: string, settings: Settings, socket: WebsiteSocket) {
	const activeAddress = await getActiveAddress(settings, socket.tabId)
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
	setWebsitePortApproval(websiteTabConnections, socket, true)

	sendSubscriptionReplyOrCallBack(websiteTabConnections, socket, { type: 'result' as const, method: 'connect', result: [settings.activeRpcNetwork.chainId] })

	// seems like dapps also want to get account changed and chain changed events after we connect again, so let's send them too
	sendSubscriptionReplyOrCallBack(websiteTabConnections, socket, { type: 'result' as const, method: 'accountsChanged', result: connectWithActiveAddress !== undefined ? [connectWithActiveAddress] : [] })

	sendSubscriptionReplyOrCallBack(websiteTabConnections, socket, { type: 'result' as const, method: 'chainChanged', result: settings.activeRpcNetwork.chainId })
	return true
}

function disconnectFromPort(
	websiteTabConnections: WebsiteTabConnections,
	socket: WebsiteSocket,
): false {
	setWebsitePortApproval(websiteTabConnections, socket, false)
	sendSubscriptionReplyOrCallBack(websiteTabConnections, socket, { type: 'result' as const, method: 'disconnect', result: [] })
	return false
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
	await requestAccessFromUser(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, socket, website, undefined, activeAddress, settings, activeAddress?.address)
}

function addIconRefreshTarget(iconRefreshTargets: Map<string, { tabId: number, websiteOrigin: string }>, tabId: number, websiteOrigin: string) {
	const key = `${ tabId }-${ websiteOrigin }`
	if (iconRefreshTargets.has(key)) return
	iconRefreshTargets.set(key, { tabId, websiteOrigin })
}

async function updateTabConnections(
	ethereum: EthereumClientService,
	tokenPriceService: TokenPriceService,
	resetSimulationServices: ResetSimulationServices,
	websiteTabConnections: WebsiteTabConnections,
	tabConnection: TabConnection,
	promptForAccessesIfNeeded: boolean,
	settings: Settings,
): Promise<Map<string, { tabId: number, websiteOrigin: string }>> {
	const iconRefreshTargets = new Map<string, { tabId: number, websiteOrigin: string }>()
	for (const key in tabConnection.connections) {
		const connection = tabConnection.connections[key]
		if (connection === undefined) throw new Error('missing connection')
		const currentActiveAddress = await getActiveAddress(settings, connection.socket.tabId)
		addIconRefreshTarget(iconRefreshTargets, connection.socket.tabId, connection.websiteOrigin)
		const access = currentActiveAddress ? hasAddressAccess(settings.websiteAccess, connection.websiteOrigin, currentActiveAddress) : hasAccess(settings.websiteAccess, connection.websiteOrigin)

		if (access !== 'hasAccess' && connection.approved) {
			disconnectFromPort(websiteTabConnections, connection.socket)
		} else if (access === 'hasAccess' && !connection.approved) {
			connectToPort(websiteTabConnections, connection.socket, settings, currentActiveAddress?.address)
		}

		if (access === 'notFound' && connection.wantsToConnect && promptForAccessesIfNeeded) {
			const activeAddress = currentActiveAddress !== undefined ? currentActiveAddress : undefined
			askUserForAccessOnConnectionUpdate(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, connection.socket, connection.websiteOrigin, activeAddress, settings)
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
	const sitesToBlock = (await getWebsiteAccess()).filter((access) => access.declarativeNetRequestBlockMode === 'block-all').map((acccess) => acccess.website.websiteOrigin)
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
	if (sitesToBlock.find((blockUrl) => blockUrl === websiteOrigin) !== undefined) return true
	if (tabIdsToBlock.find((blockTab) => blockTab === tabId) !== undefined) return true
	return false
}

export async function updateWebsiteApprovalAccesses(
	ethereum: EthereumClientService,
	tokenPriceServiceOrWebsiteTabConnections: TokenPriceService | WebsiteTabConnections,
	resetSimulationServicesOrSettings: ResetSimulationServices | Settings,
	websiteTabConnectionsOrPrompt: WebsiteTabConnections | boolean,
	settingsOrPrompt: Settings | boolean,
	promptForAccessesIfNeeded: boolean,
): Promise<number> {
	const usingLegacySignature = tokenPriceServiceOrWebsiteTabConnections instanceof Map
	const tokenPriceService = usingLegacySignature ? undefined as never : tokenPriceServiceOrWebsiteTabConnections
	const resetSimulationServices = usingLegacySignature ? undefined as never : resetSimulationServicesOrSettings as ResetSimulationServices
	const websiteTabConnections = usingLegacySignature ? tokenPriceServiceOrWebsiteTabConnections : websiteTabConnectionsOrPrompt as WebsiteTabConnections
	const settings = usingLegacySignature ? resetSimulationServicesOrSettings as Settings : settingsOrPrompt as Settings
	const promptForAccesses = typeof (usingLegacySignature ? websiteTabConnectionsOrPrompt : promptForAccessesIfNeeded) === 'boolean'
		? usingLegacySignature ? websiteTabConnectionsOrPrompt as boolean : promptForAccessesIfNeeded
		: promptForAccessesIfNeeded
	const popupRefreshGeneration = bumpPopupRefreshGeneration()
	const allTabStates = await getAllTabStates()
	const iconRefreshTargets = new Map<string, { tabId: number, websiteOrigin: string }>()

	try {
		await updateDeclarativeNetRequestBlocks(websiteTabConnections)
	} catch (error) {
		await handleUnexpectedError(error)
	}
	// update port connections and disconnect from ports that should not have access anymore
	const updatePromises = [...websiteTabConnections.entries()].map(async ([_tab, tabConnection]) => {
		const tabIconRefreshTargets = await updateTabConnections(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, tabConnection, promptForAccesses, settings)
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
		await handleUnexpectedError(error)
	}
	const iconRefreshPromises = [...iconRefreshTargets.values()].map(({ tabId, websiteOrigin }) =>
		updateExtensionIcon(websiteTabConnections, tabId, websiteOrigin, popupRefreshGeneration)
	)
	try {
		await Promise.all(iconRefreshPromises)
	} catch (error) {
		await handleUnexpectedError(error)
	}
	return popupRefreshGeneration
}
