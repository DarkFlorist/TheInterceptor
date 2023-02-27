import { EthereumAddress, SupportedETHRPCCalls } from '../utils/wire-types.js'
import { postMessageIfStillConnected, setEthereumNodeBlockPolling } from './background.js'
import { getActiveAddress } from './backgroundUtils.js'
import { findAddressInfo } from './metadataUtils.js'
import { requestAccessFromUser } from './windows/interceptorAccess.js'
import { METAMASK_ERROR_USER_REJECTED_REQUEST } from '../utils/constants.js'
import { EthereumQuantity } from '../utils/wire-types.js'
import { retrieveWebsiteDetails, updateExtensionIcon } from './iconHandler.js'
import { AddressInfoEntry, Website } from '../utils/user-interface-types.js'
import { Settings, WebsiteAccessArray, WebsiteAddressAccess } from '../utils/interceptor-messages.js'

function setWebsitePortApproval(port: browser.runtime.Port, websiteOrigin: string, approved: boolean) {
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
		websiteOrigin: websiteOrigin,
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

	const websiteOrigin = (new URL(port.sender.url)).hostname
	// ask user for permission only if this is an RPC method that we handle. otherwise some metamask callbacks will trigger access request
	// we could just ask user permisson on eth_request accounts, but I feel its more dynamic when you can use any eth method for it
	const isRpcMethod = SupportedETHRPCCalls.includes(callMethod) !== undefined
	const activeAddress = getActiveAddress()
	if (activeAddress !== undefined) {

		const addressAccess = hasAddressAccess(window.interceptor.settings.websiteAccess, websiteOrigin, activeAddress)
		if (addressAccess === 'hasAccess') {
			return connectToPort(port, websiteOrigin)
		}

		// access not found, ask access
		const addressInfo = findAddressInfo(activeAddress, window.interceptor.settings.userAddressBook.addressInfos)
		const website = await retrieveWebsiteDetails(port, websiteOrigin)
		const accessReply = await requestAccessFromUser(port, website, addressInfo, getAssociatedAddresses(window.interceptor.settings, websiteOrigin, addressInfo ))
		if (accessReply.userRequestedAddressChange) {
			const changedActiveAddress = getActiveAddress()
			if (changedActiveAddress === undefined) return false
			const addressAccess = hasAddressAccess(window.interceptor.settings.websiteAccess, websiteOrigin, changedActiveAddress)
			if (addressAccess === 'hasAccess') {
				return connectToPort(port, websiteOrigin)
			}
			return false
		}

		if (addressAccess === 'notFound'
			&& isRpcMethod
			&& accessReply.approved
			&& accessReply.requestAccessToAddress === addressInfo.address
		) {
			return connectToPort(port, websiteOrigin)
		}

		return false
	}

	const access = hasAccess(window.interceptor.settings.websiteAccess, websiteOrigin)
	if (access === 'hasAccess') {
		return connectToPort(port, websiteOrigin)
	}

	const website = await retrieveWebsiteDetails(port, websiteOrigin)
	const accessReply = await requestAccessFromUser(port, website, undefined, getAssociatedAddresses(window.interceptor.settings, websiteOrigin, undefined ) )
	if (accessReply.userRequestedAddressChange === true || accessReply.requestAccessToAddress !== undefined) throw new Error('We did not ask for address specific address but got one anyway')

	if (access === 'notFound'
		&& isRpcMethod
		&& accessReply.approved
		&& accessReply.requestAccessToAddress === undefined
	) {
		return connectToPort(port, websiteOrigin)
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
		const activeAddress = getActiveAddressForDomain(window.interceptor.settings.websiteAccess, connection.websiteOrigin)
		postMessageIfStillConnected(port, {
			interceptorApproved: true,
			options: { method: 'accountsChanged' },
			result: activeAddress !== undefined ? [EthereumAddress.serialize(activeAddress)] : []
		})
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
			const askForAddressAccess = window.interceptor.settings?.userAddressBook.addressInfos.find((x) => x.address === address )?.askForAddressAccess
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

function connectToPort(port: browser.runtime.Port, websiteOrigin: string): true {
	setWebsitePortApproval(port, websiteOrigin, true)
	updateExtensionIcon(port)

	if (window.interceptor.settings === undefined) return true
	if (window.interceptor.settings.activeChain === undefined) return true

	postMessageIfStillConnected(port, {
		interceptorApproved: true,
		options: { method: 'connect' },
		result: [EthereumQuantity.serialize(window.interceptor.settings.activeChain)]
	})

	// seems like dapps also want to get account changed and chain changed events after we connect again, so let's send them too
	const activeAddress = getActiveAddressForDomain(window.interceptor.settings.websiteAccess, websiteOrigin)
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

function disconnectFromPort(port: browser.runtime.Port, websiteOrigin: string): false {
	setWebsitePortApproval(port, websiteOrigin, false)
	updateExtensionIcon(port)

	postMessageIfStillConnected(port, {
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

async function askUserForAccessOnConnectionUpdate(port: browser.runtime.Port, websiteOrigin: string, activeAddress: AddressInfoEntry | undefined) {
	if (window.interceptor.settings === undefined) return

	const website = await retrieveWebsiteDetails(port, websiteOrigin)
	const accessReply = await requestAccessFromUser(port, website, activeAddress, getAssociatedAddresses(window.interceptor.settings, websiteOrigin, activeAddress))
	// here if the reply was for diferent address (requestAccessFromUser can change the target address), we still want to connect even if the address is diferent
	if (accessReply.approved) {
		connectToPort(port, websiteOrigin)
	}
}

export function updateWebsiteApprovalAccesses() {
	if (window.interceptor.settings === undefined) return

	const activeAddress = getActiveAddress()
	// update port connections and disconnect from ports that should not have access anymore
	for (const [port, connection] of window.interceptor.websitePortApprovals.entries() ) {
		updateExtensionIcon(port)
		const websiteAccess = hasAccess(window.interceptor.settings.websiteAccess, connection.websiteOrigin)
		if (activeAddress) {
			// check for address access changes
			const addressAccess = hasAddressAccess(window.interceptor.settings.websiteAccess, connection.websiteOrigin, activeAddress)

			if (addressAccess === 'notFound') {
				askUserForAccessOnConnectionUpdate(port, connection.websiteOrigin, findAddressInfo(activeAddress, window.interceptor.settings.userAddressBook.addressInfos) )
			}

			// access has been denied or removed for the address, but it was approved before
			if ( addressAccess !== 'hasAccess' && connection.approved) {
				disconnectFromPort(port, connection.websiteOrigin)
				continue
			}
			// access has been granted for the address and it was not approved before
			if ( addressAccess === 'hasAccess' && !connection.approved) {
				connectToPort(port, connection.websiteOrigin)
				continue
			}
			continue
		}

		if (websiteAccess === 'notFound') {
			askUserForAccessOnConnectionUpdate(port, connection.websiteOrigin, undefined)
		}

		// access has been denied or removed for the whole webpage, but it was approved before
		if ( websiteAccess !== 'hasAccess' && connection.approved) {
			disconnectFromPort(port, connection.websiteOrigin)
			continue
		}

		// access has been granted, but it was rejected before
		if ( websiteAccess === 'hasAccess' && !connection.approved) {
			connectToPort(port, connection.websiteOrigin)
			continue
		}
	}
}
