import { addressString } from '../utils/bigint.js'
import { EthereumAddress, SupportedETHRPCCalls } from '../utils/wire-types.js'
import { postMessageIfStillConnected, setEthereumNodeBlockPolling } from './background.js'
import { getActiveAddress } from './backgroundUtils.js'
import { findAddressInfo } from './metadataUtils.js'
import { Settings, WebsiteAccess, WebsiteAddressAccess } from './settings.js'
import { requestAccessFromUser, retrieveIcon } from './windows/interceptorAccess.js'
import { METAMASK_ERROR_USER_REJECTED_REQUEST } from '../utils/constants.js'
import { EthereumQuantity } from '../utils/wire-types.js'
import { updateExtensionIcon } from './iconHandler.js'
import { AddressInfoEntry } from '../utils/user-interface-types.js'

function setWebsitePortApproval(port: browser.runtime.Port, origin: string, approved: boolean) {
	const tabId = port.sender?.tab?.id
	if (window.interceptor.websitePortApprovals.get(port) === undefined) {
		setEthereumNodeBlockPolling(true)
		// if we don't already have this connection, clean up afterwards
		port.onDisconnect.addListener((port) => {
			window.interceptor.websitePortApprovals.delete(port)
			if (window.interceptor.websitePortApprovals.size === 0) {
				setEthereumNodeBlockPolling(false)
			}

			if (tabId !== undefined) {
				//check if there are still ports using this tab, if not, delete
				if (Array.from(window.interceptor.websitePortApprovals.entries()).filter( ([mapPort, _approval]) => mapPort.sender?.tab?.id === tabId ).length == 0) {
					window.interceptor.websiteTabApprovals.delete(tabId)
				}
			}
		})
	}
	const websiteApproval = {
		origin: origin,
		approved: approved
	}
	window.interceptor.websitePortApprovals.set(port, websiteApproval)
	if (tabId !== undefined) {
		window.interceptor.websiteTabApprovals.set(tabId, websiteApproval)
	}
}

export async function verifyAccess(port: browser.runtime.Port, callMethod: string) {
	if (port.sender === undefined || port.sender.url === undefined) return false
	if (window.interceptor.settings == undefined) return false

	// check if access has been granted/rejected already
	const connection = window.interceptor.websitePortApprovals.get(port)
	if ( connection && connection.approved ) return true

	const origin = (new URL(port.sender.url)).hostname
	// ask user for permission only if this is an RPC method that we handle. otherwise some metamask callbacks will trigger access request
	// we could just ask user permisson on eth_request accounts, but I feel its more dynamic when you can use any eth method for it
	const isRpcMethod = SupportedETHRPCCalls.includes(callMethod) !== undefined
	const activeAddress = getActiveAddress()
	if (activeAddress !== undefined) {

		const address = addressString(activeAddress)
		const addressAccess = hasAddressAccess(window.interceptor.settings.websiteAccess, origin, address)
		if (addressAccess === 'hasAccess') {
			return connectToPort(port, origin)
		}

		// access not found, ask access
		if (addressAccess === 'notFound' && isRpcMethod
			&& await requestAccessFromUser(origin, await retrieveIcon(port.sender?.tab?.id), address, getAssociatedAddresses(window.interceptor.settings, origin, addressString(activeAddress) ))
		) {
			return connectToPort(port, origin)
		}

		return false
	}

	const access = hasAccess(window.interceptor.settings.websiteAccess, origin)
	if (access === 'hasAccess') {
		return connectToPort(port, origin)
	}

	if (access === 'notFound' && isRpcMethod
		&& await requestAccessFromUser(origin, await retrieveIcon(port.sender?.tab?.id), undefined, getAssociatedAddresses(window.interceptor.settings, origin, undefined ) )
	) {
		return connectToPort(port, origin)
	}

	return false
}

export function sendMessageToApprovedWebsitePorts(method: string, data: unknown) {
	// inform all the tabs about the address change
	for (const [port, connection] of window.interceptor.websitePortApprovals.entries() ) {
		if ( !connection.approved ) continue
		postMessageIfStillConnected(port, {
			interceptorApproved: true,
			options: { method: method },
			result: data
		})
	}
}
export function sendActiveAccountChangeToApprovedWebsitePorts() {
	if ( !window.interceptor.settings ) return
	// inform all the tabs about the address change
	for (const [port, connection] of window.interceptor.websitePortApprovals.entries() ) {
		if ( !connection.approved ) continue
		const activeAddress = getActiveAddressForDomain(window.interceptor.settings.websiteAccess, connection.origin)
		postMessageIfStillConnected(port, {
			interceptorApproved: true,
			options: { method: 'accountsChanged' },
			result: activeAddress !== undefined ? [EthereumAddress.serialize(activeAddress)] : []
		})
	}
}

export function hasAccess(websiteAccess: readonly WebsiteAccess[], origin: string) : 'hasAccess' | 'noAccess' | 'notFound' {
	for (const web of websiteAccess) {
		if (web.origin === origin) {
			return web.access ? 'hasAccess' : 'noAccess'
		}
	}
	return 'notFound'
}

export function hasAddressAccess(websiteAccess: readonly WebsiteAccess[], origin: string, address: string) : 'hasAccess' | 'noAccess' | 'notFound' {
	for (const web of websiteAccess) {
		if (web.origin === origin) {
			if (!web.access) return 'noAccess'
			if (web.addressAccess !== undefined) {
				for (const addressAccess of web.addressAccess ) {
					if ( addressAccess.address === address ) {
						return addressAccess.access ? 'hasAccess' : 'noAccess'
					}
				}
			}
			const askForAddresssAccess = window.interceptor.settings?.addressInfos.find((x) => addressString(x.address) === address )?.askForAddressAccess
			if (askForAddresssAccess === false) return 'hasAccess'
			return 'notFound'
		}
	}
	return 'notFound'
}

export function getAddressAccesses(websiteAccess: readonly WebsiteAccess[], origin: string) : readonly WebsiteAddressAccess[] {
	for (const web of websiteAccess) {
		if (web.origin === origin) {
			return web.addressAccess === undefined ? [] : web.addressAccess
		}
	}
	return []
}
export function getAddressesThatDoNotNeedIndividualAccesses(settings: Settings) : readonly bigint[] {
	return settings.addressInfos.filter( (x) => x.askForAddressAccess === false).map( (x) => x.address)
}

export function setAccess(websiteAccess: readonly WebsiteAccess[], origin: string, originIcon: string | undefined, access: boolean, address: string | undefined) : readonly WebsiteAccess[] {
	const oldAccess = hasAccess(websiteAccess, origin)
	if ( oldAccess === 'notFound') {
		return [...websiteAccess,
			{
				origin: origin,
				originIcon: originIcon,
				access: access,
				addressAccess: address === undefined || !access ? undefined : [ { address: address, access: access } ]
			}
		]
	}
	return websiteAccess.map( (x) => {
		if( x.origin === origin) {
			if (address === undefined) {
				return {
					origin: origin,
					originIcon: x.originIcon ? x.originIcon : originIcon,
					access: access,
					addressAccess: x.addressAccess,
				}
			}
			if (x.addressAccess === undefined) {
				return {
					origin: origin,
					originIcon: x.originIcon ? x.originIcon : originIcon,
					access: x.access ? x.access : access,
					addressAccess:  [ { address: address, access: access } ]
				}
			}
			if (x.addressAccess.find( (x) => x.address === address) === undefined) {
				return {
					origin: origin,
					originIcon: x.originIcon ? x.originIcon : originIcon,
					access: x.access ? x.access : access,
					addressAccess:  [ ...x.addressAccess, { address: address, access: access } ]
				}
			}
			return {
				origin: origin,
				originIcon: x.originIcon ? x.originIcon : originIcon,
				access: x.access ? x.access : access,
				addressAccess: x.addressAccess.map( (x) => ( x.address === address ? { address: address, access: access } : x ) )
			}
		}
		return x
	})
}

// gets active address if the website has been give access for it, otherwise returns undefined
// this is to guard websites from seeing addresses without access
export function getActiveAddressForDomain(websiteAccess: readonly WebsiteAccess[], origin: string) {
	const activeAddress = getActiveAddress()
	if ( activeAddress === undefined) return undefined
	const hasAccess = hasAddressAccess(websiteAccess, origin, addressString(activeAddress))
	if( hasAccess === 'hasAccess' ) {
		return activeAddress
	}
	return undefined
}

function connectToPort(port: browser.runtime.Port, origin: string): true {
	setWebsitePortApproval(port, origin, true)
	updateExtensionIcon(port)

	if (window.interceptor.settings === undefined) return true
	if (window.interceptor.settings.activeChain === undefined) return true

	postMessageIfStillConnected(port, {
		interceptorApproved: true,
		options: { method: 'connect' },
		result: [EthereumQuantity.serialize(window.interceptor.settings.activeChain)]
	})

	// seems like dapps also want to get account changed and chain changed events after we connect again, so let's send them too
	const activeAddress = getActiveAddressForDomain(window.interceptor.settings.websiteAccess, origin)
	postMessageIfStillConnected(port, {
		interceptorApproved: true,
		options: { method: 'accountsChanged' },
		result: activeAddress !== undefined ? [EthereumAddress.serialize(activeAddress)] : []
	})

	postMessageIfStillConnected(port, {
		interceptorApproved: true,
		options: { method: 'chainChanged' },
		result: EthereumQuantity.serialize(window.interceptor.settings.activeChain)
	})
	return true
}

function disconnectFromPort(port: browser.runtime.Port, origin: string): false {
	setWebsitePortApproval(port, origin, false)
	updateExtensionIcon(port)

	postMessageIfStillConnected(port, {
		interceptorApproved: true,
		options: { method: 'disconnect' },
		result: { code: METAMASK_ERROR_USER_REJECTED_REQUEST, message: 'User refused access to the wallet' }
	})
	return false
}

export function getAssociatedAddresses(settings: Settings, origin: string, activeAddress: string | undefined) : [string, AddressInfoEntry][]{
	const addressAccess = getAddressAccesses(settings.websiteAccess, origin).filter( (x) => x.access).map( (x) => x.address)
	const allAccessAddresses = getAddressesThatDoNotNeedIndividualAccesses(settings)

	const all = allAccessAddresses.map( (address) => addressString(address) ).concat(addressAccess).concat(activeAddress === undefined ? [] : [activeAddress])
	return Array.from(new Set(all)).map(x => [x, findAddressInfo(BigInt(x), settings.addressInfos)])
}

async function askUserForAccessOnConnectionUpdate(port: browser.runtime.Port, origin: string, activeAddress: string | undefined) {
	if (window.interceptor.settings === undefined) return

	if(await requestAccessFromUser(origin, await retrieveIcon(port.sender?.tab?.id), activeAddress, getAssociatedAddresses(window.interceptor.settings, origin, activeAddress))) {
		connectToPort(port, origin)
	}
}

export function updateWebsiteApprovalAccesses() {
	if (window.interceptor.settings === undefined) return

	const activeAddress = getActiveAddress()
	// update port connections and disconnect from ports that should not have access anymore
	for (const [port, connection] of window.interceptor.websitePortApprovals.entries() ) {
		updateExtensionIcon(port)
		const websiteAccess = hasAccess(window.interceptor.settings.websiteAccess, connection.origin)
		if (activeAddress) {
			// check for address access changes
			const addressAccess = hasAddressAccess(window.interceptor.settings.websiteAccess, connection.origin, addressString(activeAddress))

			if (addressAccess === 'notFound') {
				askUserForAccessOnConnectionUpdate(port, connection.origin, addressString(activeAddress))
			}

			// access has been denied or removed for the address, but it was approved before
			if ( addressAccess !== 'hasAccess' && connection.approved) {
				disconnectFromPort(port, connection.origin)
				continue
			}
			// access has been granted for the address and it was not approved before
			if ( addressAccess === 'hasAccess' && !connection.approved) {
				connectToPort(port, connection.origin)
				continue
			}
			continue
		}

		if (websiteAccess === 'notFound') {
			askUserForAccessOnConnectionUpdate(port, connection.origin, undefined)
		}

		// access has been denied or removed for the whole webpage, but it was approved before
		if ( websiteAccess !== 'hasAccess' && connection.approved) {
			disconnectFromPort(port, connection.origin)
			continue
		}

		// access has been granted, but it was rejected before
		if ( websiteAccess === 'hasAccess' && !connection.approved) {
			connectToPort(port, connection.origin)
			continue
		}
	}
}
