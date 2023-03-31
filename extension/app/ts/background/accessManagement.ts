import { EthereumAddress, SupportedETHRPCCalls } from '../utils/wire-types.js'
import { postMessageIfStillConnected } from './background.js'
import { getActiveAddress, websiteSocketToString } from './backgroundUtils.js'
import { findAddressInfo } from './metadataUtils.js'
import { requestAccessFromUser } from './windows/interceptorAccess.js'
import { METAMASK_ERROR_USER_REJECTED_REQUEST } from '../utils/constants.js'
import { EthereumQuantity } from '../utils/wire-types.js'
import { retrieveWebsiteDetails, updateExtensionIcon } from './iconHandler.js'
import { AddressInfoEntry, TabConnection, Website, WebsiteSocket, WebsiteTabConnections } from '../utils/user-interface-types.js'
import { Settings, WebsiteAccessArray, WebsiteAddressAccess } from '../utils/interceptor-messages.js'
import { updateWebsiteAccess } from './settings.js'

export function getConnectionDetails(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket) {
	const identifier = websiteSocketToString(socket)
	const tabConnection = websiteTabConnections.get(socket.tabId)
	return tabConnection?.connections[identifier]
}

function setWebsitePortApproval(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, approved: boolean) {
	const connection = getConnectionDetails(websiteTabConnections, socket)
	if (connection == undefined) return
	if (approved) connection.wantsToConnect = true
	connection.approved = approved
}

export function verifyAccess(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, callMethod: string, websiteOrigin: string, settings: Settings): 'hasAccess' | 'noAccess' | 'askAccess' {
	const connection = getConnectionDetails(websiteTabConnections, socket)
	if (connection && connection.approved) return 'hasAccess'

	const isRpcMethod = SupportedETHRPCCalls.includes(callMethod) !== undefined
	const activeAddress = getActiveAddress(settings)
	const access = activeAddress !== undefined ? hasAddressAccess(settings.websiteAccess, websiteOrigin, activeAddress, settings) : hasAccess(settings.websiteAccess, websiteOrigin)
	if (access === 'hasAccess') return connectToPort(websiteTabConnections, socket, websiteOrigin, settings) ? 'hasAccess' : 'noAccess'
	if (access === 'noAccess') return 'noAccess'
	return isRpcMethod ? 'askAccess' : 'noAccess'
}

export function sendMessageToApprovedWebsitePorts(websiteTabConnections: WebsiteTabConnections, method: string, data: unknown) {
	// inform all the tabs about the address change
	for (const [_tab, tabConnection] of websiteTabConnections.entries() ) {
		for (const [_string, connection] of Object.entries(tabConnection.connections) ) {
			if ( !connection.approved ) continue
			postMessageIfStillConnected(websiteTabConnections, connection.socket, {
				interceptorApproved: true,
				options: { method: method },
				result: data
			})
		}
	}
}
export function sendActiveAccountChangeToApprovedWebsitePorts(websiteTabConnections: WebsiteTabConnections, settings: Settings) {
	// inform all the tabs about the address change
	for (const [_tab, tabConnection] of websiteTabConnections.entries() ) {
		for (const [_string, connection] of Object.entries(tabConnection.connections) ) {
			if ( !connection.approved ) continue
			const activeAddress = getActiveAddressForDomain(settings.websiteAccess, connection.websiteOrigin, settings)
			postMessageIfStillConnected(websiteTabConnections, connection.socket, {
				interceptorApproved: true,
				options: { method: 'accountsChanged' },
				result: activeAddress !== undefined ? [EthereumAddress.serialize(activeAddress)] : []
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
			const askForAddressAccess = settings.userAddressBook.addressInfos.find((x) => x.address === address )?.askForAddressAccess
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
	return settings.userAddressBook.addressInfos.filter( (x) => x.askForAddressAccess === false).map( (x) => x.address)
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
export function getActiveAddressForDomain(websiteAccess: WebsiteAccessArray, websiteOrigin: string, settings: Settings) {
	const activeAddress = getActiveAddress(settings)
	if ( activeAddress === undefined) return undefined
	const hasAccess = hasAddressAccess(websiteAccess, websiteOrigin, activeAddress, settings)
	if( hasAccess === 'hasAccess' ) {
		return activeAddress
	}
	return undefined
}

function connectToPort(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, websiteOrigin: string, settings: Settings): true {
	setWebsitePortApproval(websiteTabConnections, socket, true)
	updateExtensionIcon(websiteTabConnections, socket, websiteOrigin)

	if (settings.activeChain === undefined) return true

	postMessageIfStillConnected(websiteTabConnections, socket, {
		interceptorApproved: true,
		options: { method: 'connect' },
		result: [EthereumQuantity.serialize(settings.activeChain)]
	})

	// seems like dapps also want to get account changed and chain changed events after we connect again, so let's send them too
	const activeAddress = getActiveAddressForDomain(settings.websiteAccess, websiteOrigin, settings)
	postMessageIfStillConnected(websiteTabConnections, socket, {
		interceptorApproved: true,
		options: { method: 'accountsChanged' },
		result: activeAddress !== undefined ? [EthereumAddress.serialize(activeAddress)] : []
	})

	postMessageIfStillConnected(websiteTabConnections, socket, {
		interceptorApproved: true,
		options: { method: 'chainChanged' },
		result: EthereumQuantity.serialize(settings.activeChain)
	})

	if (!settings.simulationMode || settings.useSignersAddressAsActiveAddress) {
		postMessageIfStillConnected(websiteTabConnections, socket, {
			interceptorApproved: true,
			options: { method: 'request_signer_to_eth_requestAccounts' },
			result: []
		})
		postMessageIfStillConnected(websiteTabConnections, socket, {
			interceptorApproved: true,
			options: { method: 'request_signer_chainId' },
			result: []
		})
	}
	return true
}

function disconnectFromPort(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, websiteOrigin: string): false {
	setWebsitePortApproval(websiteTabConnections, socket, false)
	updateExtensionIcon(websiteTabConnections, socket, websiteOrigin)
	postMessageIfStillConnected(websiteTabConnections, socket, {
		interceptorApproved: true,
		options: { method: 'disconnect' },
		result: { code: METAMASK_ERROR_USER_REJECTED_REQUEST, message: 'User refused access to the wallet' }
	})
	return false
}

export function getAssociatedAddresses(settings: Settings, websiteOrigin: string, activeAddress: AddressInfoEntry | undefined) : AddressInfoEntry[] {
	const addressAccess = getAddressAccesses(settings.websiteAccess, websiteOrigin).filter( (x) => x.access).map( (x) => x.address)
	const allAccessAddresses = getAddressesThatDoNotNeedIndividualAccesses(settings)

	const all = allAccessAddresses.concat(addressAccess).concat(activeAddress === undefined ? [] : [activeAddress.address])
	return Array.from(new Set(all)).map(x => findAddressInfo(x, settings.userAddressBook.addressInfos))
}

async function askUserForAccessOnConnectionUpdate(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, websiteOrigin: string, activeAddress: AddressInfoEntry | undefined, settings: Settings) {
	const details = getConnectionDetails(websiteTabConnections, socket)
	if (details === undefined) return

	const website = await retrieveWebsiteDetails(details.port, websiteOrigin)
	await requestAccessFromUser(websiteTabConnections, socket, website, undefined, activeAddress, getAssociatedAddresses(settings, websiteOrigin, activeAddress), settings)
}

function updateTabConnections(websiteTabConnections: WebsiteTabConnections, tabConnection: TabConnection, promptForAccessesIfNeeded: boolean, settings: Settings) {
	const activeAddress = getActiveAddress(settings)
	for (const [_string, connection] of Object.entries(tabConnection.connections) ) {
		updateExtensionIcon(websiteTabConnections, connection.socket, connection.websiteOrigin)
		const access = activeAddress ? hasAddressAccess(settings.websiteAccess, connection.websiteOrigin, activeAddress, settings) : hasAccess(settings.websiteAccess, connection.websiteOrigin)

		if (access !== 'hasAccess' && connection.approved) {
			disconnectFromPort(websiteTabConnections, connection.socket, connection.websiteOrigin)
		} else if (access === 'hasAccess' && !connection.approved) {
			connectToPort(websiteTabConnections, connection.socket, connection.websiteOrigin, settings)
		}

		if (access === 'notFound' && connection.wantsToConnect && promptForAccessesIfNeeded) {
			const addressInfo = activeAddress ? findAddressInfo(activeAddress, settings.userAddressBook.addressInfos) : undefined
			askUserForAccessOnConnectionUpdate(websiteTabConnections, connection.socket, connection.websiteOrigin, addressInfo, settings)
		}
	}
}

export function updateWebsiteApprovalAccesses(websiteTabConnections: WebsiteTabConnections, promptForAccessesIfNeeded: boolean = true, settings: Settings) {
	// update port connections and disconnect from ports that should not have access anymore
	for (const [_tab, tabConnection] of websiteTabConnections.entries() ) {
		updateTabConnections(websiteTabConnections, tabConnection, promptForAccessesIfNeeded, settings)
	}
}
