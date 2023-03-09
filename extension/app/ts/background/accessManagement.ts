import { EthereumAddress, SupportedETHRPCCalls } from '../utils/wire-types.js'
import { postMessageIfStillConnected } from './background.js'
import { getActiveAddress, websiteSocketToString } from './backgroundUtils.js'
import { findAddressInfo } from './metadataUtils.js'
import { requestAccessFromUser } from './windows/interceptorAccess.js'
import { METAMASK_ERROR_USER_REJECTED_REQUEST } from '../utils/constants.js'
import { EthereumQuantity } from '../utils/wire-types.js'
import { retrieveWebsiteDetails, updateExtensionIcon } from './iconHandler.js'
import { AddressInfoEntry, TabConnection, Website, WebsiteSocket } from '../utils/user-interface-types.js'
import { Settings, WebsiteAccessArray, WebsiteAddressAccess } from '../utils/interceptor-messages.js'

export function getConnectionDetails(socket: WebsiteSocket) {
	const identifier = websiteSocketToString(socket)
	const tabConnection = globalThis.interceptor.websiteTabConnections.get(socket.tabId)
	return tabConnection?.connections[identifier]
}

function setWebsitePortApproval(socket: WebsiteSocket, approved: boolean) {
	const connection = getConnectionDetails(socket)
	if (connection == undefined) return
	if (approved) connection.wantsToConnect = true
	connection.approved = approved
}

export function verifyAccess(socket: WebsiteSocket, callMethod: string, websiteOrigin: string): 'hasAccess' | 'noAccess' | 'askAccess' {
	if (globalThis.interceptor.settings == undefined) return 'noAccess'
	const connection = getConnectionDetails(socket)
	if (connection && connection.approved) return 'hasAccess'

	const isRpcMethod = SupportedETHRPCCalls.includes(callMethod) !== undefined
	const activeAddress = getActiveAddress()
	const access = activeAddress !== undefined ? hasAddressAccess(globalThis.interceptor.settings.websiteAccess, websiteOrigin, activeAddress) : hasAccess(globalThis.interceptor.settings.websiteAccess, websiteOrigin)
	if (access === 'hasAccess') return connectToPort(socket, websiteOrigin) ? 'hasAccess' : 'noAccess'
	return isRpcMethod ? 'askAccess' : 'noAccess'
}

export function sendMessageToApprovedWebsitePorts(method: string, data: unknown) {
	// inform all the tabs about the address change
	for (const [_tab, tabConnection] of globalThis.interceptor.websiteTabConnections.entries() ) {
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
	for (const [_tab, tabConnection] of globalThis.interceptor.websiteTabConnections.entries() ) {
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

	if (!globalThis.interceptor.settings.simulationMode || globalThis.interceptor.settings.useSignersAddressAsActiveAddress) {
		postMessageIfStillConnected(socket, {
			interceptorApproved: true,
			options: { method: 'request_signer_to_eth_requestAccounts' },
			result: []
		})
		postMessageIfStillConnected(socket, {
			interceptorApproved: true,
			options: { method: 'request_signer_chainId' },
			result: []
		})
	}
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
	await requestAccessFromUser(socket, website, undefined, activeAddress, getAssociatedAddresses(globalThis.interceptor.settings, websiteOrigin, activeAddress))
}

function updateTabConnections(tabConnection: TabConnection) {
	if (globalThis.interceptor.settings === undefined) return

	const activeAddress = getActiveAddress()
	for (const [_string, connection] of Object.entries(tabConnection.connections) ) {
		updateExtensionIcon(connection.socket, connection.websiteOrigin)
		const access = activeAddress ? hasAddressAccess(globalThis.interceptor.settings.websiteAccess, connection.websiteOrigin, activeAddress) : hasAccess(globalThis.interceptor.settings.websiteAccess, connection.websiteOrigin)

		if (access !== 'hasAccess' && connection.approved) {
			disconnectFromPort(connection.socket, connection.websiteOrigin)
		} else if (access === 'hasAccess' && !connection.approved) {
			connectToPort(connection.socket, connection.websiteOrigin)
		}

		if (access === 'notFound' && connection.wantsToConnect) {
			const addressInfo = activeAddress ? findAddressInfo(activeAddress, globalThis.interceptor.settings.userAddressBook.addressInfos) : undefined
			askUserForAccessOnConnectionUpdate(connection.socket, connection.websiteOrigin, addressInfo)
		}
	}
}

export function updateWebsiteApprovalAccesses() {
	// update port connections and disconnect from ports that should not have access anymore
	for (const [_tab, tabConnection] of globalThis.interceptor.websiteTabConnections.entries() ) {
		updateTabConnections(tabConnection)
	}
}
