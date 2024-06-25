import { getActiveAddress, getActiveAddressesForAllTabs, websiteSocketToString } from './backgroundUtils.js'
import { getActiveAddressEntry, getActiveAddresses } from './metadataUtils.js'
import { requestAccessFromUser } from './windows/interceptorAccess.js'
import { retrieveWebsiteDetails, updateExtensionIcon } from './iconHandler.js'
import { TabConnection, WebsiteTabConnections } from '../types/user-interface-types.js'
import { InpageScriptCallBack, Settings } from '../types/interceptor-messages.js'
import { getSettings, getWebsiteAccess, updateWebsiteAccess } from './settings.js'
import { sendSubscriptionReplyOrCallBack } from './messageSending.js'
import { Simulator } from '../simulation/simulator.js'
import { WebsiteSocket } from '../utils/requests.js'
import { Website, WebsiteAccessArray, WebsiteAddressAccess } from '../types/websiteAccessTypes.js'
import { getUniqueItemsByProperties, replaceElementInReadonlyArray } from '../utils/typed-arrays.js'
import { modifyObject } from '../utils/typescript.js'
import { AddressBookEntries, AddressBookEntry } from '../types/addressBookTypes.js'
import { Semaphore } from '../utils/semaphore.js'
import { JsonRpcRequest } from '../types/JsonRpc-types.js'
import { handleInterceptedRequest, handleRPCRequest } from './background.js'
import { getSimulationResults } from './storageVariables.js'

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
	if (access === 'hasAccess') return connectToPort(websiteTabConnections, socket, websiteOrigin, settings, requestAccessForAddress?.address) ? 'hasAccess' : 'noAccess'
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
				const websiteData = {
					...website,
					icon: prevAccess.website.icon ?? website.icon,
					title: prevAccess.website.title ?? website.title,
				}
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

function connectToPort(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, websiteOrigin: string, settings: Settings, connectWithActiveAddress: bigint | undefined): true {
	setWebsitePortApproval(websiteTabConnections, socket, true)
	updateExtensionIcon(websiteTabConnections, socket.tabId, websiteOrigin)

	sendSubscriptionReplyOrCallBack(websiteTabConnections, socket, { type: 'result' as const, method: 'connect', result: [settings.currentRpcNetwork.chainId] })

	// seems like dapps also want to get account changed and chain changed events after we connect again, so let's send them too
	sendSubscriptionReplyOrCallBack(websiteTabConnections, socket, { type: 'result' as const, method: 'accountsChanged', result: connectWithActiveAddress !== undefined ? [connectWithActiveAddress] : [] })

	sendSubscriptionReplyOrCallBack(websiteTabConnections, socket, { type: 'result' as const, method: 'chainChanged', result: settings.currentRpcNetwork.chainId })

	if (!settings.simulationMode || settings.useSignersAddressAsActiveAddress) {
		sendSubscriptionReplyOrCallBack(websiteTabConnections, socket, { type: 'result' as const, method: 'request_signer_to_eth_requestAccounts', result: [] })
		sendSubscriptionReplyOrCallBack(websiteTabConnections, socket, { type: 'result' as const, method: 'request_signer_chainId', result: [] })
	}
	return true
}

function disconnectFromPort(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, websiteOrigin: string): false {
	setWebsitePortApproval(websiteTabConnections, socket, false)
	updateExtensionIcon(websiteTabConnections, socket.tabId, websiteOrigin)
	sendSubscriptionReplyOrCallBack(websiteTabConnections, socket, { type: 'result' as const, method: 'disconnect', result: [] })
	return false
}

export async function getAssociatedAddresses(settings: Settings, websiteOrigin: string, activeAddress: AddressBookEntry | undefined) : Promise<AddressBookEntries> {
	const addressAccess = await Promise.all(getAddressAccesses(settings.websiteAccess, websiteOrigin).filter((x) => x.access).map((x) => x.address).map((x) => getActiveAddressEntry(x)))
	const allAccessAddresses = getAddressesThatDoNotNeedIndividualAccesses(await getActiveAddresses())
	const all = allAccessAddresses.concat(addressAccess).concat(activeAddress === undefined ? [] : [activeAddress])
	return getUniqueItemsByProperties(all, ['address'])
}

async function askUserForAccessOnConnectionUpdate(simulator: Simulator, websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, websiteOrigin: string, activeAddress: AddressBookEntry | undefined, settings: Settings) {
	const details = getConnectionDetails(websiteTabConnections, socket)
	if (details === undefined) return

	const website = { websiteOrigin, ...await retrieveWebsiteDetails(socket.tabId) }
	await requestAccessFromUser(simulator, websiteTabConnections, socket, website, undefined, activeAddress, settings, activeAddress?.address)
}

async function updateTabConnections(simulator: Simulator, websiteTabConnections: WebsiteTabConnections, tabConnection: TabConnection, promptForAccessesIfNeeded: boolean, settings: Settings) {
	for (const key in tabConnection.connections) {
		const connection = tabConnection.connections[key]
		if (connection === undefined) throw new Error('missing connection')
		const currentActiveAddress = await getActiveAddress(settings, connection.socket.tabId)
		updateExtensionIcon(websiteTabConnections, connection.socket.tabId, connection.websiteOrigin)
		const access = currentActiveAddress ? hasAddressAccess(settings.websiteAccess, connection.websiteOrigin, currentActiveAddress) : hasAccess(settings.websiteAccess, connection.websiteOrigin)

		if (access !== 'hasAccess' && connection.approved) {
			disconnectFromPort(websiteTabConnections, connection.socket, connection.websiteOrigin)
		} else if (access === 'hasAccess' && !connection.approved) {
			connectToPort(websiteTabConnections, connection.socket, connection.websiteOrigin, settings, currentActiveAddress?.address)
		}

		if (access === 'notFound' && connection.wantsToConnect && promptForAccessesIfNeeded) {
			const activeAddress = currentActiveAddress !== undefined ? currentActiveAddress : undefined
			askUserForAccessOnConnectionUpdate(simulator, websiteTabConnections, connection.socket, connection.websiteOrigin, activeAddress, settings)
		}
	}
}

const getApprovedTabs = (websiteTabConnections: WebsiteTabConnections) => {
	const approvedTabs = new Set<number>()
	for (const [tab, tabConnection] of websiteTabConnections.entries() ) {
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

let webRequestListener: (details: browser.webRequest._OnBeforeRequestDetails) => void = () => {}
let previousDecralativeNetRequestBlockIdentifier = ''
const updateDeclarativeNetRequestBlocksSemaphore = new Semaphore(1)
export async function updateDeclarativeNetRequestBlocks(websiteTabConnections: WebsiteTabConnections, simulator: Simulator) {
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
						id: dynamicRuleIds.length == 0 ? 1 : Math.max.apply(null, dynamicRuleIds) + 1,
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
						id: sessionRuleIds.length == 0 ? 1 : Math.max.apply(null, sessionRuleIds) + 1,
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
				if (details !== undefined && details.requestBody && details.requestBody.raw) {
					const raw = details.requestBody.raw[0]?.bytes
					if (raw === undefined) return
					function arrayBufferToString(buffer: ArrayBuffer): string {
						const uint8Array = new Uint8Array(buffer);
						const decoder = new TextDecoder('utf-8');
						return decoder.decode(uint8Array);
					}
					// Convert the raw ArrayBuffer to a string
					const requestBodyString = arrayBufferToString(raw);
					
					// Try to parse the string as JSON (if applicable)
					let parsedData;
					try {
						parsedData = JSON.parse(requestBodyString)
						const jsonRpc = JsonRpcRequest.safeParse(parsedData)
						if (jsonRpc.success === false) return 
						const connection = websiteTabConnections.get(details.tabId)
						if (connection === undefined) return
						const socket = connection.connections[0]?.socket
						if (socket === undefined) return
						const websiteOrigin = (new URL('initiator' in details ? details.initiator as any as string : '')).hostname
						const website = { websiteOrigin, ...await retrieveWebsiteDetails(details.tabId) }
						const settings = await getSettings()
						const simulationState = settings.simulationMode ? (await getSimulationResults()).simulationState : undefined
						handleRPCRequest(
							simulator,
							simulationState,
							websiteTabConnections,
							socket,
							website,
							{ ...jsonRpc.value,
								interceptorRequest: true,
								usingInterceptorWithoutSigner: true,
								uniqueRequestIdentifier: { requestId: -jsonRpc.value.id, requestSocket: socket }
							},
							settings,
							undefined,
						)
					} catch (e) {}

					console.log(details.url)
				}


				if (tabIdsToBlock.find((tabId) => tabId === details.tabId) !== undefined) return { cancel: true }
				if (details.originUrl === undefined) return {}
				if (details.type === 'main_frame') return {}
				const websiteOrigin = (new URL(details.originUrl)).hostname
				const destinationHost = (new URL(details.url)).hostname
				if (destinationHost === websiteOrigin) return {}
				if (sitesToBlock.find((blockUrl) => blockUrl === websiteOrigin) !== undefined) return { cancel: true }
				return {}
			}
			//if (sitesToBlock.length === 0 && tabIdsToBlock.length === 0) return
			browser.webRequest.onBeforeRequest.addListener(webRequestListener, { urls: ['<all_urls>'] }, ['blocking', 'requestBody'])
		}
	})
}

export const areWeBlocking = async (websiteTabConnections: WebsiteTabConnections, tabId: number, websiteOrigin: string) => {
	const { tabIdsToBlock, sitesToBlock } = await getTabsAndAddressesToBlock(websiteTabConnections)
	if (sitesToBlock.find((blockUrl) => blockUrl === websiteOrigin) !== undefined) return true
	if (tabIdsToBlock.find((blockTab) => blockTab === tabId) !== undefined) return true
	return false
}

export function updateWebsiteApprovalAccesses(simulator: Simulator, websiteTabConnections: WebsiteTabConnections, settings: Settings, promptForAccessesIfNeeded = true) {
	updateDeclarativeNetRequestBlocks(websiteTabConnections)
	// update port connections and disconnect from ports that should not have access anymore
	for (const [_tab, tabConnection] of websiteTabConnections.entries()) {
		updateTabConnections(simulator, websiteTabConnections, tabConnection, promptForAccessesIfNeeded, settings)
	}
}
