import { getActiveAddress, websiteSocketToString } from './backgroundUtils.js'
import { getActiveAddressEntry } from './metadataUtils.js'
import { requestAccessFromUser } from './windows/interceptorAccess.js'
import { retrieveWebsiteDetails, updateExtensionIcon } from './iconHandler.js'
import { TabConnection, WebsiteTabConnections } from '../types/user-interface-types.js'
import { InpageScriptCallBack, Settings } from '../types/interceptor-messages.js'
import { updateWebsiteAccess } from './settings.js'
import { sendSubscriptionReplyOrCallBack } from './messageSending.js'
import { Simulator } from '../simulation/simulator.js'
import { WebsiteSocket } from '../utils/requests.js'
import { ActiveAddressEntry } from '../types/addressBookTypes.js'
import { Website, WebsiteAccessArray, WebsiteAddressAccess } from '../types/websiteAccessTypes.js'

export function getConnectionDetails(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket) {
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

export type ApprovalState = 'hasAccess' | 'noAccess' | 'askAccess'

export function verifyAccess(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, askAccessIfUnknown: boolean, websiteOrigin: string, requestAccessForAddress: bigint | undefined, settings: Settings): ApprovalState {
	const connection = getConnectionDetails(websiteTabConnections, socket)
	if (connection && connection.approved) return 'hasAccess'
	const access = requestAccessForAddress !== undefined ? hasAddressAccess(settings.websiteAccess, websiteOrigin, requestAccessForAddress, settings) : hasAccess(settings.websiteAccess, websiteOrigin)
	if (access === 'hasAccess') return connectToPort(websiteTabConnections, socket, websiteOrigin, settings, requestAccessForAddress) ? 'hasAccess' : 'noAccess'
	if (access === 'noAccess') return 'noAccess'
	return askAccessIfUnknown ? 'askAccess' : 'noAccess'
}

export function sendMessageToApprovedWebsitePorts(websiteTabConnections: WebsiteTabConnections, message:  InpageScriptCallBack) {
	// inform all the tabs about the address change
	for (const [_tab, tabConnection] of websiteTabConnections.entries() ) {
		for (const key in tabConnection.connections) {
			const connection = tabConnection.connections[key]
			if (connection === undefined) throw new Error('missing connection')
			if (!connection.approved) continue
			sendSubscriptionReplyOrCallBack(websiteTabConnections, connection.socket, message)
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
				method: 'accountsChanged',
				result: activeAddress !== undefined ? [activeAddress] : []
			})
		}
	}
}

export function hasAccess(websiteAccess: WebsiteAccessArray, websiteOrigin: string) : 'hasAccess' | 'noAccess' | 'notFound' {
	for (const web of websiteAccess) {
		if (web.website.websiteOrigin === websiteOrigin) {
			return web.access ? 'hasAccess' : 'noAccess'
		}
	}
	return 'notFound'
}

export function hasAddressAccess(websiteAccess: WebsiteAccessArray, websiteOrigin: string, address: bigint, settings: Settings) : 'hasAccess' | 'noAccess' | 'notFound' {
	for (const web of websiteAccess) {
		if (web.website.websiteOrigin === websiteOrigin) {
			if (!web.access) return 'noAccess'
			if (web.addressAccess !== undefined) {
				for (const addressAccess of web.addressAccess ) {
					if ( addressAccess.address === address ) {
						return addressAccess.access ? 'hasAccess' : 'noAccess'
					}
				}
			}
			const askForAddressAccess = settings.userAddressBook.activeAddresses.find((x) => x.address === address )?.askForAddressAccess
			if (askForAddressAccess === false) return 'hasAccess'
			return 'notFound'
		}
	}
	return 'notFound'
}

export function getAddressAccesses(websiteAccess: WebsiteAccessArray, websiteOrigin: string) : readonly WebsiteAddressAccess[] {
	for (const web of websiteAccess) {
		if (web.website.websiteOrigin === websiteOrigin) {
			return web.addressAccess === undefined ? [] : web.addressAccess
		}
	}
	return []
}
export function getAddressesThatDoNotNeedIndividualAccesses(settings: Settings) : readonly bigint[] {
	return settings.userAddressBook.activeAddresses.filter( (x) => x.askForAddressAccess === false).map( (x) => x.address)
}

export async function setAccess(website: Website, access: boolean, address: bigint | undefined) {
	return await updateWebsiteAccess((previousWebsiteAccess) => {
		const oldAccess = hasAccess(previousWebsiteAccess, website.websiteOrigin)
		if (oldAccess === 'notFound') {
			return [...previousWebsiteAccess,
				{
					website,
					access: access,
					addressAccess: address === undefined || !access ? undefined : [ { address: address, access: access } ]
				}
			]
		}
		return previousWebsiteAccess.map((prevAccess) => {
			if (prevAccess.website.websiteOrigin === website.websiteOrigin) {
				if (address === undefined) {
					return {
						website: {
							...website,
							icon: prevAccess.website.icon ? prevAccess.website.icon : website.icon,
							title: prevAccess.website.title ? prevAccess.website.title : website.title,
						},
						access: access,
						addressAccess: prevAccess.addressAccess,
					}
				}
				if (prevAccess.addressAccess === undefined) {
					return {
						website: {
							...website,
							icon: prevAccess.website.icon ? prevAccess.website.icon : website.icon,
							title: prevAccess.website.title ? prevAccess.website.title : website.title,
						},
						access: prevAccess.access ? prevAccess.access : access,
						addressAccess:  [ { address: address, access: access } ]
					}
				}
				if (prevAccess.addressAccess.find((x) => x.address === address) === undefined) {
					return {
						website: {
							...website,
							icon: prevAccess.website.icon ? prevAccess.website.icon : website.icon,
							title: prevAccess.website.title ? prevAccess.website.title : website.title,
						},
						access: prevAccess.access ? prevAccess.access : access,
						addressAccess:  [ ...prevAccess.addressAccess, { address: address, access: access } ]
					}
				}
				return {
					website: {
						...website,
						icon: prevAccess.website.icon ? prevAccess.website.icon : website.icon,
						title: prevAccess.website.title ? prevAccess.website.title : website.title,
					},
					access: prevAccess.access ? prevAccess.access : access,
					addressAccess: prevAccess.addressAccess.map((x) => ( x.address === address ? { address: address, access: access } : x ) )
				}
			}
			return prevAccess
		})
	})
}

// gets active address if the website has been give access for it, otherwise returns undefined
// this is to guard websites from seeing addresses without access
export async function getActiveAddressForDomain(websiteOrigin: string, settings: Settings, socket: WebsiteSocket) {
	const activeAddress = await getActiveAddress(settings, socket.tabId)
	if (activeAddress === undefined) return undefined
	const hasAccess = hasAddressAccess(settings.websiteAccess, websiteOrigin, activeAddress, settings)
	if (hasAccess === 'hasAccess') return activeAddress
	return undefined
}

function connectToPort(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, websiteOrigin: string, settings: Settings, connectWithActiveAddress: bigint | undefined): true {
	setWebsitePortApproval(websiteTabConnections, socket, true)
	updateExtensionIcon(websiteTabConnections, socket, websiteOrigin)

	sendSubscriptionReplyOrCallBack(websiteTabConnections, socket, { method: 'connect', result: [settings.rpcNetwork.chainId] })

	// seems like dapps also want to get account changed and chain changed events after we connect again, so let's send them too
	sendSubscriptionReplyOrCallBack(websiteTabConnections, socket, { method: 'accountsChanged', result: connectWithActiveAddress !== undefined ? [connectWithActiveAddress] : [] })

	sendSubscriptionReplyOrCallBack(websiteTabConnections, socket, { method: 'chainChanged', result: settings.rpcNetwork.chainId })

	if (!settings.simulationMode || settings.useSignersAddressAsActiveAddress) {
		sendSubscriptionReplyOrCallBack(websiteTabConnections, socket, { method: 'request_signer_to_eth_requestAccounts', result: [] })
		sendSubscriptionReplyOrCallBack(websiteTabConnections, socket, { method: 'request_signer_chainId', result: [] })
	}
	return true
}

function disconnectFromPort(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, websiteOrigin: string): false {
	setWebsitePortApproval(websiteTabConnections, socket, false)
	updateExtensionIcon(websiteTabConnections, socket, websiteOrigin)
	sendSubscriptionReplyOrCallBack(websiteTabConnections, socket, { method: 'disconnect', result: [] })
	return false
}

export function getAssociatedAddresses(settings: Settings, websiteOrigin: string, activeAddress: ActiveAddressEntry | undefined) : ActiveAddressEntry[] {
	const addressAccess = getAddressAccesses(settings.websiteAccess, websiteOrigin).filter( (x) => x.access).map( (x) => x.address)
	const allAccessAddresses = getAddressesThatDoNotNeedIndividualAccesses(settings)

	const all = allAccessAddresses.concat(addressAccess).concat(activeAddress === undefined ? [] : [activeAddress.address])
	return Array.from(new Set(all)).map(x => getActiveAddressEntry(x, settings.userAddressBook.activeAddresses))
}

async function askUserForAccessOnConnectionUpdate(simulator: Simulator, websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, websiteOrigin: string, activeAddress: ActiveAddressEntry | undefined, settings: Settings) {
	const details = getConnectionDetails(websiteTabConnections, socket)
	if (details === undefined) return

	const website = await retrieveWebsiteDetails(details.port, websiteOrigin)
	await requestAccessFromUser(simulator, websiteTabConnections, socket, website, undefined, activeAddress, settings, activeAddress?.address)
}

async function updateTabConnections(simulator: Simulator, websiteTabConnections: WebsiteTabConnections, tabConnection: TabConnection, promptForAccessesIfNeeded: boolean, settings: Settings) {
	for (const key in tabConnection.connections) {
		const connection = tabConnection.connections[key]
		if (connection === undefined) throw new Error('missing connection')
		const currentActiveAddress = await getActiveAddress(settings, connection.socket.tabId)
		updateExtensionIcon(websiteTabConnections, connection.socket, connection.websiteOrigin)
		const access = currentActiveAddress ? hasAddressAccess(settings.websiteAccess, connection.websiteOrigin, currentActiveAddress, settings) : hasAccess(settings.websiteAccess, connection.websiteOrigin)

		if (access !== 'hasAccess' && connection.approved) {
			disconnectFromPort(websiteTabConnections, connection.socket, connection.websiteOrigin)
		} else if (access === 'hasAccess' && !connection.approved) {
			connectToPort(websiteTabConnections, connection.socket, connection.websiteOrigin, settings, currentActiveAddress)
		}

		if (access === 'notFound' && connection.wantsToConnect && promptForAccessesIfNeeded) {
			const activeAddress = currentActiveAddress ? getActiveAddressEntry(currentActiveAddress, settings.userAddressBook.activeAddresses) : undefined
			askUserForAccessOnConnectionUpdate(simulator, websiteTabConnections, connection.socket, connection.websiteOrigin, activeAddress, settings)
		}
	}
}

export function updateWebsiteApprovalAccesses(simulator: Simulator, websiteTabConnections: WebsiteTabConnections, promptForAccessesIfNeeded: boolean = true, settings: Settings) {
	// update port connections and disconnect from ports that should not have access anymore
	for (const [_tab, tabConnection] of websiteTabConnections.entries() ) {
		updateTabConnections(simulator, websiteTabConnections, tabConnection, promptForAccessesIfNeeded, settings)
	}
}
