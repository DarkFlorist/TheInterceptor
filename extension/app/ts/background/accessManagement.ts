import { EthereumAddress, SupportedETHRPCCalls } from '../utils/wire-types.js'
import { postMessageIfStillConnected } from './background.js'
import { getActiveAddress, getSocketFromPort, websiteSocketToString } from './backgroundUtils.js'
import { findAddressInfo } from './metadataUtils.js'
import { requestAccessFromUser } from './windows/interceptorAccess.js'
import { METAMASK_ERROR_USER_REJECTED_REQUEST } from '../utils/constants.js'
import { EthereumQuantity } from '../utils/wire-types.js'
import { retrieveWebsiteDetails, updateExtensionIcon } from './iconHandler.js'
import { AddressInfoEntry, TabConnection, Website, WebsiteSocket } from '../utils/user-interface-types.js'
import { Settings, WebsiteAccessArray, WebsiteAddressAccess } from '../utils/interceptor-messages.js'

export function getConnectionDetails(socket: WebsiteSocket) {
	const identifier = websiteSocketToString(socket)
	const tabConnection = globalThis.interceptor.websiteTabConnection.get(socket.tabId)
	return tabConnection?.connections[identifier]
}

function setWebsitePortApproval(socket: WebsiteSocket, approved: boolean) {
	const connection = getConnectionDetails(socket)
	if (connection) {
		connection.approved = approved
	}
}

export async function verifyAccess(port: browser.runtime.Port, callMethod: string) {
	if (port.sender === undefined || port.sender.url === undefined) return false
	if (globalThis.interceptor.settings == undefined) return false
	const tabId = port.sender?.tab?.id
	if (tabId === undefined) return false

	const socket = getSocketFromPort(port)

	// check if access has been granted/rejected already
	const connection = getConnectionDetails(socket)
	if ( connection && connection.approved ) return true

	const websiteOrigin = (new URL(port.sender.url)).hostname
	// ask user for permission only if this is an RPC method that we handle. otherwise some metamask callbacks will trigger access request
	// we could just ask user permisson on eth_request accounts, but I feel its more dynamic when you can use any eth method for it
	const isRpcMethod = SupportedETHRPCCalls.includes(callMethod) !== undefined
	const activeAddress = getActiveAddress()
	if (activeAddress !== undefined) {

		const addressAccess = hasAddressAccess(globalThis.interceptor.settings.websiteAccess, websiteOrigin, activeAddress)
		if (addressAccess === 'hasAccess') {
			return connectToPort(socket, websiteOrigin)
		}

		// access not found, ask access
		const addressInfo = findAddressInfo(activeAddress, globalThis.interceptor.settings.userAddressBook.addressInfos)
		const website = await retrieveWebsiteDetails(port, websiteOrigin)
		const accessReply = await requestAccessFromUser(socket, website, addressInfo, getAssociatedAddresses(globalThis.interceptor.settings, websiteOrigin, addressInfo))
		if (accessReply.userRequestedAddressChange) {
			const changedActiveAddress = getActiveAddress()
			if (changedActiveAddress === undefined) return false
			const addressAccess = hasAddressAccess(globalThis.interceptor.settings.websiteAccess, websiteOrigin, changedActiveAddress)
			if (addressAccess === 'hasAccess') {
				return connectToPort(socket, websiteOrigin)
			}
			return false
		}

		if (addressAccess === 'notFound'
			&& isRpcMethod
			&& accessReply.approved
			&& accessReply.requestAccessToAddress === addressInfo.address
		) {
			return connectToPort(socket, websiteOrigin)
		}

		return false
	}

	const access = hasAccess(globalThis.interceptor.settings.websiteAccess, websiteOrigin)
	if (access === 'hasAccess') {
		return connectToPort(socket, websiteOrigin)
	}

	const website = await retrieveWebsiteDetails(port, websiteOrigin)
	const accessReply = await requestAccessFromUser(socket, website, undefined, getAssociatedAddresses(globalThis.interceptor.settings, websiteOrigin, undefined ) )
	if (accessReply.userRequestedAddressChange === true || accessReply.requestAccessToAddress !== undefined) throw new Error('We did not ask for address specific address but got one anyway')

	if (access === 'notFound'
		&& isRpcMethod
		&& accessReply.approved
		&& accessReply.requestAccessToAddress === undefined
	) {
		return connectToPort(socket, websiteOrigin)
	}

	return false
}

export function sendMessageToApprovedWebsitePorts(method: string, data: unknown) {
	// inform all the tabs about the address change
	for (const [_tab, tabConnection] of globalThis.interceptor.websiteTabConnection.entries() ) {
		for (const [_string, connection] of Object.entries(tabConnection.connections) ) {
			if ( !connection.approved ) continue
			postMessageIfStillConnected(connection.socket, {
				interceptorApproved: true,
				options: { method: method },
				result: data
			})
		}
	}
}
export function sendActiveAccountChangeToApprovedWebsitePorts() {
	if ( !globalThis.interceptor.settings ) return
	// inform all the tabs about the address change
	for (const [_tab, tabConnection] of globalThis.interceptor.websiteTabConnection.entries() ) {
		for (const [_string, connection] of Object.entries(tabConnection.connections) ) {
			if ( !connection.approved ) continue
			const activeAddress = getActiveAddressForDomain(globalThis.interceptor.settings.websiteAccess, connection.websiteOrigin)
			postMessageIfStillConnected(connection.socket, {
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

export function hasAddressAccess(websiteAccess: WebsiteAccessArray, websiteOrigin: string, address: bigint) : 'hasAccess' | 'noAccess' | 'notFound' {
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
			const askForAddressAccess = globalThis.interceptor.settings?.userAddressBook.addressInfos.find((x) => x.address === address )?.askForAddressAccess
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

export function setAccess(websiteAccess: WebsiteAccessArray, website: Website, access: boolean, address: bigint | undefined) : WebsiteAccessArray {
	const oldAccess = hasAccess(websiteAccess, website.websiteOrigin)
	if ( oldAccess === 'notFound') {
		return [...websiteAccess,
			{
				website,
				access: access,
				addressAccess: address === undefined || !access ? undefined : [ { address: address, access: access } ]
			}
		]
	}
	return websiteAccess.map( (x) => {
		if( x.website.websiteOrigin === website.websiteOrigin) {
			if (address === undefined) {
				return {
					website: {
						...website,
						icon: x.website.icon ? x.website.icon : website.icon,
						title: x.website.title ? x.website.title : website.title,
					},
					access: access,
					addressAccess: x.addressAccess,
				}
			}
			if (x.addressAccess === undefined) {
				return {
					website: {
						...website,
						icon: x.website.icon ? x.website.icon : website.icon,
						title: x.website.title ? x.website.title : website.title,
					},
					access: x.access ? x.access : access,
					addressAccess:  [ { address: address, access: access } ]
				}
			}
			if (x.addressAccess.find( (x) => x.address === address) === undefined) {
				return {
					website: {
						...website,
						icon: x.website.icon ? x.website.icon : website.icon,
						title: x.website.title ? x.website.title : website.title,
					},
					access: x.access ? x.access : access,
					addressAccess:  [ ...x.addressAccess, { address: address, access: access } ]
				}
			}
			return {
				website: {
					...website,
					icon: x.website.icon ? x.website.icon : website.icon,
					title: x.website.title ? x.website.title : website.title,
				},
				access: x.access ? x.access : access,
				addressAccess: x.addressAccess.map( (x) => ( x.address === address ? { address: address, access: access } : x ) )
			}
		}
		return x
	})
}

// gets active address if the website has been give access for it, otherwise returns undefined
// this is to guard websites from seeing addresses without access
export function getActiveAddressForDomain(websiteAccess: WebsiteAccessArray, websiteOrigin: string) {
	const activeAddress = getActiveAddress()
	if ( activeAddress === undefined) return undefined
	const hasAccess = hasAddressAccess(websiteAccess, websiteOrigin, activeAddress)
	if( hasAccess === 'hasAccess' ) {
		return activeAddress
	}
	return undefined
}

function connectToPort(socket: WebsiteSocket, websiteOrigin: string): true {
	setWebsitePortApproval(socket, true)
	updateExtensionIcon(socket, websiteOrigin)

	if (globalThis.interceptor.settings === undefined) return true
	if (globalThis.interceptor.settings.activeChain === undefined) return true

	postMessageIfStillConnected(socket, {
		interceptorApproved: true,
		options: { method: 'connect' },
		result: [EthereumQuantity.serialize(globalThis.interceptor.settings.activeChain)]
	})

	// seems like dapps also want to get account changed and chain changed events after we connect again, so let's send them too
	const activeAddress = getActiveAddressForDomain(globalThis.interceptor.settings.websiteAccess, websiteOrigin)
	postMessageIfStillConnected(socket, {
		interceptorApproved: true,
		options: { method: 'accountsChanged' },
		result: activeAddress !== undefined ? [EthereumAddress.serialize(activeAddress)] : []
	})

	postMessageIfStillConnected(socket, {
		interceptorApproved: true,
		options: { method: 'chainChanged' },
		result: EthereumQuantity.serialize(globalThis.interceptor.settings.activeChain)
	})
	return true
}

function disconnectFromPort(socket: WebsiteSocket, websiteOrigin: string): false {
	setWebsitePortApproval(socket, false)
	updateExtensionIcon(socket, websiteOrigin)
	postMessageIfStillConnected(socket, {
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

async function askUserForAccessOnConnectionUpdate(socket: WebsiteSocket, websiteOrigin: string, activeAddress: AddressInfoEntry | undefined) {
	if (globalThis.interceptor.settings === undefined) return
	const details = getConnectionDetails(socket)
	if (details === undefined) return

	const website = await retrieveWebsiteDetails(details.port, websiteOrigin)
	await requestAccessFromUser(socket, website, activeAddress, getAssociatedAddresses(globalThis.interceptor.settings, websiteOrigin, activeAddress))
}

function updateTabConnections(tabConnection: TabConnection) {
	if (globalThis.interceptor.settings === undefined) return

	const activeAddress = getActiveAddress()
	for (const [_string, connection] of Object.entries(tabConnection.connections) ) {
		updateExtensionIcon(connection.socket, connection.websiteOrigin)

		const websiteAccess = hasAccess(globalThis.interceptor.settings.websiteAccess, connection.websiteOrigin)
		if (activeAddress) {
			// check for address access changes
			const addressAccess = hasAddressAccess(globalThis.interceptor.settings.websiteAccess, connection.websiteOrigin, activeAddress)

			if (addressAccess === 'notFound') {
				askUserForAccessOnConnectionUpdate(connection.socket, connection.websiteOrigin, findAddressInfo(activeAddress, globalThis.interceptor.settings.userAddressBook.addressInfos) )
			}

			// access has been denied or removed for the address, but it was approved before
			if ( addressAccess !== 'hasAccess' && connection.approved) {
				disconnectFromPort(connection.socket, connection.websiteOrigin)
				continue
			}
			// access has been granted for the address and it was not approved before
			if ( addressAccess === 'hasAccess' && !connection.approved) {
				connectToPort(connection.socket, connection.websiteOrigin)
				continue
			}
			continue
		}

		if (websiteAccess === 'notFound') {
			askUserForAccessOnConnectionUpdate(connection.socket, connection.websiteOrigin, undefined)
		}

		// access has been denied or removed for the whole webpage, but it was approved before
		if ( websiteAccess !== 'hasAccess' && connection.approved) {
			disconnectFromPort(connection.socket, connection.websiteOrigin)
			continue
		}

		// access has been granted, but it was rejected before
		if ( websiteAccess === 'hasAccess' && !connection.approved) {
			connectToPort(connection.socket, connection.websiteOrigin)
			continue
		}
	}
}

export function updateWebsiteApprovalAccesses() {
	// update port connections and disconnect from ports that should not have access anymore
	for (const [_tab, tabConnection] of globalThis.interceptor.websiteTabConnection.entries() ) {
		updateTabConnections(tabConnection)
	}
}
