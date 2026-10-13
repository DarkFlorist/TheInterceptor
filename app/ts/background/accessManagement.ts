import { getActiveAddress, getWebsiteSocketConnection, websiteSocketToString } from './backgroundUtils.js'
import { getActiveAddressEntryForChain, getActiveAddresses } from './metadataUtils.js'
import { updateExtensionIcon } from './iconHandler.js'
import type { TabConnection, WebsiteTabConnections } from '../types/user-interface-types.js'
import type { InpageScriptCallBack, Settings } from '../types/interceptor-messages.js'
import { updateWebsiteAccess } from './settings.js'
import { sendSubscriptionReplyOrCallBack } from './messageSending.js'
import type { WebsiteSocket } from '../utils/requests.js'
import { getAllTabStates } from './storageVariables.js'
import type { Website, WebsiteAccessArray, WebsiteAddressAccess } from '../types/websiteAccessTypes.js'
import { getUniqueItemsByProperties, replaceElementInReadonlyArray } from '../utils/typed-arrays.js'
import { modifyObject } from '../utils/typescript.js'
import type { AddressBookEntries, AddressBookEntry } from '../types/addressBookTypes.js'
import { mergeStoredWebsiteMetadata } from '../utils/websiteIcons.js'
import { reportUnexpectedError } from '../utils/errors.js'
import { bumpPopupRefreshGeneration } from './popupRefreshGeneration.js'
import { getActiveAddressForCurrentSignerState } from './signerStateOwnership.js'
import { getAddressBookEntriesForChainIdMorePreciseFirst } from '../utils/addressBook.js'
import { notifyWebsiteLifecycle } from './websiteLifecycle.js'
import { hasAccess, hasAddressAccess, type ApprovalState } from './websiteAccessPolicy.js'
import { getWebsiteActiveAddress } from './websiteActiveAddress.js'
import { updateWebsiteAccessAndContentScriptInjectionStrategy } from './websiteAccessUpdating.js'
import { updateDeclarativeNetRequestBlocks } from './websiteRequestBlocking.js'
import type { LockedSettings } from './settingsTransitionLock.js'

function setWebsitePortApproval(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, approved: boolean) {
	const connection = getWebsiteSocketConnection(websiteTabConnections, socket)
	if (connection === undefined) return
	if (approved) connection.wantsToConnect = true
	connection.approved = approved
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

type VerifyAccessOptions = {
	readonly ignoreConnectionApproval?: boolean
}

export function verifyAccess(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, askAccessIfUnknown: boolean, websiteOrigin: string, requestAccessForAddress: AddressBookEntry | undefined, settings: Settings, options: VerifyAccessOptions = {}): ApprovalState {
	const connection = getWebsiteSocketConnection(websiteTabConnections, socket)
	if (connection?.approved && options.ignoreConnectionApproval !== true) return 'hasAccess'
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
			const activeAddress = await getWebsiteActiveAddress(websiteTabConnections, connection.websiteOrigin, settings, connection.socket)
			sendSubscriptionReplyOrCallBack(websiteTabConnections, connection.socket, {
				type: 'result' as const,
				method: 'accountsChanged',
				result: activeAddress !== undefined ? [activeAddress.address] : []
			})
		}
	}
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
	return await updateWebsiteAccessAndContentScriptInjectionStrategy((previousWebsiteAccess) => {
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

function connectToPort(
	websiteTabConnections: WebsiteTabConnections,
	socket: WebsiteSocket,
	settings: Settings,
	connectWithActiveAddress: bigint | undefined,
): true {
	const wasApproved = getWebsiteSocketConnection(websiteTabConnections, socket)?.approved === true
	setWebsitePortApproval(websiteTabConnections, socket, true)
	if (!wasApproved) notifyWebsiteLifecycle(websiteTabConnections.lifecycle?.approvalChanged, socket, true)
	if (!shouldSendUnscopedConnectionEvents(socket)) return true
	sendProviderConnectionEventsToPort(websiteTabConnections, socket, settings, connectWithActiveAddress === undefined ? [] : [connectWithActiveAddress])
	return true
}

export function sendProviderConnectionEventsToPort(
	websiteTabConnections: WebsiteTabConnections,
	socket: WebsiteSocket,
	settings: Settings,
	accounts: readonly bigint[],
) {
	sendSubscriptionReplyOrCallBack(websiteTabConnections, socket, { type: 'result' as const, method: 'connect', result: [settings.activeRpcNetwork.chainId] })
	sendSubscriptionReplyOrCallBack(websiteTabConnections, socket, { type: 'result' as const, method: 'accountsChanged', result: accounts })
	sendSubscriptionReplyOrCallBack(websiteTabConnections, socket, { type: 'result' as const, method: 'chainChanged', result: settings.activeRpcNetwork.chainId })
}

export function sendAccountsChangedToPort(
	websiteTabConnections: WebsiteTabConnections,
	socket: WebsiteSocket,
	accounts: readonly bigint[],
	requestId: number,
) {
	sendSubscriptionReplyOrCallBack(websiteTabConnections, socket, { type: 'result' as const, method: 'accountsChanged', result: accounts, requestId })
}

function disconnectFromPort(
	websiteTabConnections: WebsiteTabConnections,
	socket: WebsiteSocket,
): false {
	notifyWebsiteLifecycle(websiteTabConnections.lifecycle?.approvalChanged, socket, false)
	setWebsitePortApproval(websiteTabConnections, socket, false)
	// Account access can be revoked without the provider losing chain connectivity. Notify account listeners before the legacy disconnect event so dapps clear stale account state.
	sendSubscriptionReplyOrCallBack(websiteTabConnections, socket, { type: 'result' as const, method: 'accountsChanged', result: [] })
	sendSubscriptionReplyOrCallBack(websiteTabConnections, socket, { type: 'result' as const, method: 'disconnect', result: [] })
	return false
}

export async function getAssociatedAddresses(settings: Settings, websiteOrigin: string, activeAddress: AddressBookEntry | undefined) : Promise<AddressBookEntries> {
	const addressAccess = await Promise.all(getAddressAccesses(settings.websiteAccess, websiteOrigin).filter((x) => x.access).map((x) => x.address).map((x) => getActiveAddressEntryForChain(x, settings.activeRpcNetwork.chainId)))
	const activeChainAddresses = getAddressBookEntriesForChainIdMorePreciseFirst(await getActiveAddresses(), settings.activeRpcNetwork.chainId)
	const allAccessAddresses = getAddressesThatDoNotNeedIndividualAccesses(activeChainAddresses)
	const all = allAccessAddresses.concat(addressAccess).concat(activeAddress === undefined ? [] : [activeAddress])
	return getUniqueItemsByProperties(all, ['address'])
}

function addIconRefreshTarget(iconRefreshTargets: Map<string, { tabId: number, websiteOrigin: string }>, tabId: number, websiteOrigin: string) {
	const key = `${ tabId }-${ websiteOrigin }`
	if (iconRefreshTargets.has(key)) return
	iconRefreshTargets.set(key, { tabId, websiteOrigin })
}

export async function getConnectionAccess(websiteTabConnections: WebsiteTabConnections, connection: TabConnection['connections'][string], settings: Settings) {
	const activeAddress = await getActiveAddressForCurrentSignerState(websiteTabConnections, settings, connection.socket.tabId, async () => await getActiveAddress(settings, connection.socket.tabId))
	const access = activeAddress ? hasAddressAccess(settings.websiteAccess, connection.websiteOrigin, activeAddress) : hasAccess(settings.websiteAccess, connection.websiteOrigin)
	return { activeAddress, access }
}

async function updateTabConnections(
	websiteTabConnections: WebsiteTabConnections,
	tabConnection: TabConnection,
	settings: Settings,
): Promise<Map<string, { tabId: number, websiteOrigin: string }>> {
	const iconRefreshTargets = new Map<string, { tabId: number, websiteOrigin: string }>()
	for (const key in tabConnection.connections) {
		const connection = tabConnection.connections[key]
		if (connection === undefined) throw new Error('missing connection')
		const { activeAddress, access } = await getConnectionAccess(websiteTabConnections, connection, settings)
		addIconRefreshTarget(iconRefreshTargets, connection.socket.tabId, connection.websiteOrigin)

		if (access !== 'hasAccess' && connection.approved) {
			disconnectFromPort(websiteTabConnections, connection.socket)
		} else if (access === 'hasAccess' && !connection.approved) {
			connectToPort(websiteTabConnections, connection.socket, settings, activeAddress?.address)
		}
	}
	return iconRefreshTargets
}

export type WebsiteAccessUpdate = {
	readonly popupRefreshGeneration: number
	readonly iconRefreshTargets: readonly { readonly tabId: number, readonly websiteOrigin: string }[]
	readonly reconciledSettings: Settings
}

// Requiring LockedSettings makes callers hold the settings transition lock, so reconciliation never interleaves with a settings change.
export async function reconcileWebsiteApprovalAccesses(
	websiteTabConnections: WebsiteTabConnections,
	lockedSettings: LockedSettings,
	throwOnError = false,
): Promise<WebsiteAccessUpdate> {
	const { settings } = lockedSettings
	const popupRefreshGeneration = bumpPopupRefreshGeneration()
	const iconRefreshTargets = new Map<string, { tabId: number, websiteOrigin: string }>()

	try {
		await updateDeclarativeNetRequestBlocks(websiteTabConnections)
	} catch (error) {
		if (throwOnError) throw error
		await reportUnexpectedError(error)
	}
	const updatePromises = [...websiteTabConnections.values()].map(async (tabConnection) => {
		const tabIconRefreshTargets = await updateTabConnections(websiteTabConnections, tabConnection, settings)
		for (const iconRefreshTarget of tabIconRefreshTargets.values()) addIconRefreshTarget(iconRefreshTargets, iconRefreshTarget.tabId, iconRefreshTarget.websiteOrigin)
	})
	try {
		await Promise.all(updatePromises)
	} catch (error) {
		if (throwOnError) throw error
		await reportUnexpectedError(error)
	}

	notifyWebsiteLifecycle(websiteTabConnections.lifecycle?.accessReconciled)
	return { popupRefreshGeneration, iconRefreshTargets: [...iconRefreshTargets.values()], reconciledSettings: settings }
}

// Refresh every tab icon touched by a reconciliation, plus stored tabs without a live connection. Call after any access prompts so icons show pending requests.
export async function refreshIconsAfterWebsiteAccessUpdate(
	websiteTabConnections: WebsiteTabConnections,
	update: WebsiteAccessUpdate,
	throwOnError = false,
) {
	const iconRefreshTargets = new Map<string, { tabId: number, websiteOrigin: string }>()
	for (const target of update.iconRefreshTargets) addIconRefreshTarget(iconRefreshTargets, target.tabId, target.websiteOrigin)
	try {
		for (const tabState of await getAllTabStates()) {
			if (websiteTabConnections.has(tabState.tabId)) continue
			if (tabState.website?.websiteOrigin === undefined) continue
			addIconRefreshTarget(iconRefreshTargets, tabState.tabId, tabState.website.websiteOrigin)
		}
		await Promise.all([...iconRefreshTargets.values()].map(({ tabId, websiteOrigin }) =>
			updateExtensionIcon(websiteTabConnections, tabId, websiteOrigin, update.popupRefreshGeneration)
		))
	} catch (error) {
		if (throwOnError) throw error
		await reportUnexpectedError(error)
	}
}
