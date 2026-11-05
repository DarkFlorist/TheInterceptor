import { getActiveAddress, getActiveAddressesForAllTabs, getWebsiteSocketConnection, isTopFramePort, sendPopupMessageToOpenWindows, websiteSocketToString } from './backgroundUtils.js'
import { getActiveAddressEntryForChain, getActiveAddresses } from './metadataUtils.js'
import { requestAccessFromUser } from './windows/interceptorAccess.js'
import { retrieveWebsiteDetails, updateExtensionIcon } from './iconHandler.js'
import type { TabConnection, TabState, WebsiteTabConnections } from '../types/user-interface-types.js'
import type { InpageScriptCallBack, Settings } from '../types/interceptor-messages.js'
import { getSettingsSnapshot, updateWebsiteAccess, settingsIfRpcConfigurationReady, requireReadableApprovals, getWebsiteApprovalsSnapshot, requireAvailableSettings } from './settings.js'
import { sendSubscriptionReplyOrCallBack } from './messageSending.js'
import { type WebsiteSocket, getHostWithPort, getTabIfExists, silenceChromeUnCaughtPromise } from '../utils/requests.js'
import { getAllTabStates, updateTabState } from './storageVariables.js'
import { createRpcConfigurationUnavailableError } from '../utils/rpcConfigurationError.js'
import type { Website, WebsiteAccessArray, WebsiteAddressAccess } from '../types/websiteAccessTypes.js'
import { getUniqueItemsByProperties, replaceElementInReadonlyArray } from '../utils/typed-arrays.js'
import { assertNever, modifyObject } from '../utils/typescript.js'
import { ICON_NOT_ACTIVE } from '../utils/constants.js'
import type { AddressBookEntries, AddressBookEntry } from '../types/addressBookTypes.js'
import { Semaphore } from '../utils/semaphore.js'
import type { SimulationServicesOwner } from '../simulation/serviceLifecycle.js'
import { mergeStoredWebsiteMetadata } from '../utils/websiteIcons.js'
import { reportAsUnexpectedError, reportUnexpectedError, surfaceFailures } from '../utils/errors.js'
import { throwAfterFollowUp } from './committedWriteReconciliation.js'
import { bumpPopupRefreshGeneration } from './popupRefreshGeneration.js'
import { getActiveAddressForCurrentSignerState, registerWebsiteConnectionAndProvisionallyClaimSignerState } from './signerStateOwnership.js'
import { getAddressBookEntriesForChainIdMorePreciseFirst } from '../utils/addressBook.js'
import { notifyWebsiteLifecycle } from './websiteLifecycle.js'
import { hasAccess, hasAddressAccess, type ApprovalState } from './websiteAccessPolicy.js'
import { getWebsiteActiveAddress } from './websiteActiveAddress.js'
import { updateWebsiteAccessAndContentScriptInjectionStrategy } from './websiteAccessUpdating.js'
import { rpcConfigurationIsReady } from './rpcConfigurationAvailability.js'

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
		void updateExtensionIcon(socket.tabId, websiteOrigin, popupRefreshGeneration).catch((error: unknown) => {
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

async function askUserForAccessOnConnectionUpdate(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, websiteOrigin: string, activeAddress: AddressBookEntry | undefined, settings: Settings) {
	const details = getWebsiteSocketConnection(websiteTabConnections, socket)
	if (details === undefined) return

	const website = { websiteOrigin, ...await retrieveWebsiteDetails(socket.tabId, websiteOrigin) }
	await requestAccessFromUser(simulationServicesOwner, websiteTabConnections, socket, website, undefined, activeAddress, settings, activeAddress, undefined)
}

function addIconRefreshTarget(iconRefreshTargets: Map<string, { tabId: number, websiteOrigin: string }>, tabId: number, websiteOrigin: string) {
	const key = `${ tabId }-${ websiteOrigin }`
	if (iconRefreshTargets.has(key)) return
	iconRefreshTargets.set(key, { tabId, websiteOrigin })
}

type WebsiteConnection = TabConnection['connections'][string]

const getConnectionActiveAddress = async (websiteTabConnections: WebsiteTabConnections, connection: WebsiteConnection, settings: Settings) => await getActiveAddressForCurrentSignerState(websiteTabConnections, settings, connection.socket.tabId, async () => await getActiveAddress(settings, connection.socket.tabId))

const getConnectionAccessForAddress = (websiteAccess: WebsiteAccessArray, connection: WebsiteConnection, activeAddress: AddressBookEntry | undefined) => activeAddress ? hasAddressAccess(websiteAccess, connection.websiteOrigin, activeAddress) : hasAccess(websiteAccess, connection.websiteOrigin)

async function getConnectionAccess(websiteTabConnections: WebsiteTabConnections, connection: WebsiteConnection, settings: Settings) {
	const activeAddress = await getConnectionActiveAddress(websiteTabConnections, connection, settings)
	return { activeAddress, access: getConnectionAccessForAddress(settings.websiteAccess, connection, activeAddress) }
}

// The current persisted settings: active RPC network, active-address fields and approvals. Anything that keeps them from being available is returned instead of thrown, with the failure a committed write's entry point surfaces: an `unavailable` snapshot (the RPC configuration is unavailable, an expected state the RPC status publishes) as the RPC-configuration-unavailable error, and a `rejected` read (an unexpected failure, for example a failed repair write of a corrupt field) as its rejection.
type AccessReconciliationSettingsRead =
	| { readonly status: 'available', readonly settings: Settings, readonly rpcConfigurationReady: boolean }
	| { readonly status: 'unavailable' | 'rejected', readonly failure: unknown }

async function readSettingsForAccessReconciliation(): Promise<AccessReconciliationSettingsRead> {
	try {
		const snapshot = await getSettingsSnapshot()
		if (snapshot.status === 'available') return { status: 'available', settings: snapshot.settings, rpcConfigurationReady: rpcConfigurationIsReady(snapshot.rpcConfiguration) }
	} catch (error: unknown) {
		return { status: 'rejected', failure: error }
	}
	return { status: 'unavailable', failure: createRpcConfigurationUnavailableError() }
}

// What one reconciliation run applies: the current settings read inside the lock, which may grant while the RPC configuration is ready, or (when they are unavailable) the caller's committed settings, which may only revoke.
type AccessReconciliationInputs = {
	readonly settings: Settings
	readonly grantsAllowed: boolean
}

// Returns the failure instead of throwing, so a failed notification never stops the caller or replaces another failure.
function disconnectIfApproved(websiteTabConnections: WebsiteTabConnections, connection: WebsiteConnection): readonly unknown[] {
	if (!connection.approved) return []
	try {
		disconnectFromPort(websiteTabConnections, connection.socket)
		return []
	} catch (error: unknown) {
		return [error]
	}
}

// Never throws: every failure of the connection's steps is returned, in order.
async function reconcileConnection(websiteTabConnections: WebsiteTabConnections, connection: WebsiteConnection, inputs: AccessReconciliationInputs): Promise<readonly unknown[]> {
	let activeAddress: AddressBookEntry | undefined
	try {
		activeAddress = await getConnectionActiveAddress(websiteTabConnections, connection, inputs.settings)
	} catch (lookupFailure: unknown) {
		// Without its active address the connection's approval cannot be verified, so it fails closed.
		return [lookupFailure, ...disconnectIfApproved(websiteTabConnections, connection)]
	}
	const access = getConnectionAccessForAddress(inputs.settings.websiteAccess, connection, activeAddress)
	if (access !== 'hasAccess') return disconnectIfApproved(websiteTabConnections, connection)
	if (connection.approved || !inputs.grantsAllowed) return []
	try {
		connectToPort(websiteTabConnections, connection.socket, inputs.settings, activeAddress?.address)
		return []
	} catch (error: unknown) {
		return [error]
	}
}

async function promptForWebsiteAccesses(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, throwOnError = false) {
	for (const tabConnection of websiteTabConnections.values()) {
		for (const connection of Object.values(tabConnection.connections)) {
			if (!connection.wantsToConnect) continue
			try {
				// Reconciliation uses the committed snapshot; deferred prompts must recheck the latest settings.
				const settings = requireAvailableSettings(await getSettingsSnapshot())
				const { activeAddress, access } = await getConnectionAccess(websiteTabConnections, connection, settings)
				if (access !== 'askAccess') continue
				await askUserForAccessOnConnectionUpdate(simulationServicesOwner, websiteTabConnections, connection.socket, connection.websiteOrigin, activeAddress, settings)
			} catch (error) {
				if (throwOnError) throw error
				await reportUnexpectedError(error)
			}
		}
	}
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
// Without a ready RPC configuration a tab's active address cannot be trusted for its chain, and runtime connection approval is not restored either (connections register unapproved and requests are refused before access checks). Tab blocking is a user privacy control that must not depend on RPC availability, so fail closed: block every connected tab that is approved at runtime or whose website has persisted consent, while any active address blocks all external requests.
const getTabIdsToBlockWithoutReadyRpcConfiguration = async (websiteTabConnections: WebsiteTabConnections, websiteAccess: WebsiteAccessArray) => {
	const anyActiveAddressBlocksAll = (await getActiveAddresses()).some((entry) => entry.declarativeNetRequestBlockMode === 'block-all')
	if (!anyActiveAddressBlocksAll) return []
	const tabIdsToBlock: number[] = []
	for (const [tabId, tabConnection] of websiteTabConnections.entries()) {
		const tabHasConsentedConnection = Object.values(tabConnection.connections).some((connection) => connection.approved || hasAccess(websiteAccess, connection.websiteOrigin) === 'hasAccess')
		if (tabHasConsentedConnection) tabIdsToBlock.push(tabId)
	}
	return tabIdsToBlock
}

type RequestBlocks = {
	readonly tabIdsToBlock: readonly number[]
	readonly sitesToBlock: readonly string[]
	// True when the tab set is only a conservative lower bound (RPC configuration not ready); tab blocks that are already applied must then be kept, never lifted.
	readonly keepAppliedTabBlocks: boolean
}

const getSitesToBlock = (websiteAccess: WebsiteAccessArray) => websiteAccess.filter((access) => access.declarativeNetRequestBlockMode === 'block-all').map((acccess) => acccess.website.websiteOrigin)

// The single tab-blocking mode decision: undefined (the RPC configuration is not ready, even if it kept a readable active network) means tab blocking is derived from persisted consent.
const getSettingsForTabBlocking = async () => settingsIfRpcConfigurationReady(await getSettingsSnapshot())

const getTabsAndAddressesToBlock = async (websiteTabConnections: WebsiteTabConnections): Promise<RequestBlocks> => {
	const approvedTabIds = getApprovedTabs(websiteTabConnections)
	const settings = await getSettingsForTabBlocking()
	if (settings === undefined) {
		// A fresh read on purpose: when storage is unreadable the snapshot's fail-closed approvals are empty, which would lift applied site blocks, so this read (like getActiveAddresses) rejects and every applied rule stays in place.
		const websiteAccess = requireReadableApprovals(await getWebsiteApprovalsSnapshot({ repairCorrupt: true }))
		return { tabIdsToBlock: await getTabIdsToBlockWithoutReadyRpcConfiguration(websiteTabConnections, websiteAccess), sitesToBlock: getSitesToBlock(websiteAccess), keepAppliedTabBlocks: true }
	}
	const tabIdsToBlock = (await getActiveAddressesForAllTabs(settings)).filter((tabData) => approvedTabIds.has(tabData.tabId)).filter((tabData) => tabData.activeAddress?.declarativeNetRequestBlockMode === 'block-all').map((tabData) => tabData.tabId)
	return { tabIdsToBlock, sitesToBlock: getSitesToBlock(requireReadableApprovals(await getWebsiteApprovalsSnapshot({ repairCorrupt: true }))), keepAppliedTabBlocks: false }
}

let webRequestListener: (details: browser.webRequest._OnBeforeRequestDetails) => void = () => undefined
let previousTabIdsToBlock: readonly number[] = []
let previousSitesToBlock: readonly string[] = []
let previousTabBlockIdentifier: string | undefined
let previousSiteBlockIdentifier: string | undefined
// MV3 session rules survive service-worker restarts, so they are the authoritative record of applied tab blocks; MV2 listeners do not survive a restart.
const getAppliedTabBlocks = async (): Promise<readonly number[]> => {
	if (browser.runtime.getManifest().manifest_version !== 3) return previousTabIdsToBlock
	return (await browser.declarativeNetRequest.getSessionRules()).flatMap((rule) => rule.condition.tabIds ?? [])
}

const getAppliedSiteBlocks = async (): Promise<readonly string[]> => {
	if (browser.runtime.getManifest().manifest_version !== 3) return previousSitesToBlock
	return (await browser.declarativeNetRequest.getDynamicRules()).flatMap((rule) => rule.condition.initiatorDomains ?? [])
}

const getTabIdsWithAppliedTabBlocks = async (tabIdsToBlock: readonly number[]) => Array.from(new Set([...await getAppliedTabBlocks(), ...tabIdsToBlock]))

const updateDeclarativeNetRequestBlocksSemaphore = new Semaphore(1)
export async function updateDeclarativeNetRequestBlocks(websiteTabConnections: WebsiteTabConnections) {
	return await updateDeclarativeNetRequestBlocksSemaphore.execute(async () => {
		const requestBlocks = await getTabsAndAddressesToBlock(websiteTabConnections)
		const { sitesToBlock } = requestBlocks
		const tabIdsToBlock = requestBlocks.keepAppliedTabBlocks ? await getTabIdsWithAppliedTabBlocks(requestBlocks.tabIdsToBlock) : requestBlocks.tabIdsToBlock
		const tabBlockIdentifier = tabIdsToBlock.join('|')
		const siteBlockIdentifier = sitesToBlock.join('|')
		const tabBlocksChanged = tabBlockIdentifier !== previousTabBlockIdentifier
		const siteBlocksChanged = siteBlockIdentifier !== previousSiteBlockIdentifier
		if (!tabBlocksChanged && !siteBlocksChanged) return

		if (browser.runtime.getManifest().manifest_version === 3) {
			if (siteBlocksChanged) {
				const dynamicRuleIds = (await browser.declarativeNetRequest.getDynamicRules()).map((rule) => rule.id)
				if (sitesToBlock.length !== 0) {
					await browser.declarativeNetRequest.updateDynamicRules({
						removeRuleIds: dynamicRuleIds,
						addRules: [{
							id: dynamicRuleIds.length === 0 ? 1 : Math.max.apply(null, dynamicRuleIds) + 1,
							priority: 1,
							action : { type: 'block' as const },
							condition: { initiatorDomains: [...sitesToBlock], domainType: 'thirdParty' as const }
						}]
					})
				} else {
					await browser.declarativeNetRequest.updateDynamicRules({ removeRuleIds: dynamicRuleIds })
				}
				previousSitesToBlock = sitesToBlock
				previousSiteBlockIdentifier = siteBlockIdentifier
			}
			if (tabBlocksChanged) {
				const sessionRuleIds = (await browser.declarativeNetRequest.getSessionRules()).map((rule) => rule.id)
				if (tabIdsToBlock.length !== 0) {
					await browser.declarativeNetRequest.updateSessionRules({
						removeRuleIds: sessionRuleIds,
						addRules: [{
							id: sessionRuleIds.length === 0 ? 1 : Math.max.apply(null, sessionRuleIds) + 1,
							priority: 2,
							action : { type: 'block' as const },
							condition: { tabIds: [...tabIdsToBlock], domainType: 'thirdParty' as const }
						}]
					})
				} else {
					await browser.declarativeNetRequest.updateSessionRules({ removeRuleIds: sessionRuleIds })
				}
				previousTabIdsToBlock = tabIdsToBlock
				previousTabBlockIdentifier = tabBlockIdentifier
			}
			// enable `declarativeNetRequestFeedback` permission to manifest and uncomment to enable debugging
			// const a = (data: any) => { console.log(data) }
			// (browser.declarativeNetRequest as any).onRuleMatchedDebug.addListener(a)
		} else {
			browser.webRequest.onBeforeRequest.removeListener(webRequestListener)
			// Nothing is applied until the replacement listener is installed, so a failed installation reports no blocking and the next reconciliation retries it.
			previousSitesToBlock = []
			previousTabIdsToBlock = []
			previousSiteBlockIdentifier = undefined
			previousTabBlockIdentifier = undefined
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
			if (sitesToBlock.length !== 0 || tabIdsToBlock.length !== 0) browser.webRequest.onBeforeRequest.addListener(webRequestListener, { urls: ['<all_urls>'] }, ['blocking'])
			previousSitesToBlock = sitesToBlock
			previousTabIdsToBlock = tabIdsToBlock
			previousSiteBlockIdentifier = siteBlockIdentifier
			previousTabBlockIdentifier = tabBlockIdentifier
		}
	})
}

// Connections register unapproved, so a new connection can only change tab blocking while it is derived from persisted consent. The RPC configuration can become unavailable after the last reconciliation, so the current snapshot decides instead of an earlier mode. Resolves true when it reconciled, i.e. when this registration may have changed its tab's blocking.
export async function updateDeclarativeNetRequestBlocksForRegisteredConnection(websiteTabConnections: WebsiteTabConnections) {
	if (await getSettingsForTabBlocking() !== undefined) return false
	await updateDeclarativeNetRequestBlocks(websiteTabConnections)
	return true
}

// Every registered connection, including a child frame in an existing tab, can make its tab eligible for request blocking (persisted consent while the active RPC network is unreadable), so blocking is reconciled for each registration. The reconciliation is returned instead of awaited so connection setup latency is unchanged; the caller must handle its failure.
export async function registerWebsiteConnectionAndReconcileRequestBlocks(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, connection: TabConnection['connections'][string], isTopFrame: boolean) {
	const registration = await registerWebsiteConnectionAndProvisionallyClaimSignerState(websiteTabConnections, socket, connection, isTopFrame)
	// Guarded so a failure before the caller attaches its handler is not reported as an unhandled rejection; the caller still observes it.
	return { ...registration, isTopFrame, requestBlocksReconciliation: silenceChromeUnCaughtPromise(updateDeclarativeNetRequestBlocksForRegisteredConnection(websiteTabConnections)) }
}

// Writes a new tab's initial state, then hands the icon refresh that observes the registration's started request-block reconciliation to `observe` (the caller's error boundary). It is handed over after the write, so the icon follows the new tab's state, and even when the write fails, so the reconciliation is always observed while the write failure still propagates; the refresh only reads state and writes the icon, so it is harmless after a failed write.
export async function initializeRegisteredConnectionTab(websiteTabConnections: WebsiteTabConnections, registration: Awaited<ReturnType<typeof registerWebsiteConnectionAndReconcileRequestBlocks>>, socket: WebsiteSocket, websiteOrigin: string, observe: (refreshIconAfterRequestBlocks: () => Promise<void>) => void) {
	try {
		if (registration.createdTabConnection) {
			await updateTabState(socket.tabId, (previousState: TabState) => modifyObject(previousState, {
				website: { websiteOrigin, icon: undefined, title: undefined },
				tabIconDetails: { icon: ICON_NOT_ACTIVE, iconReason: 'No active address selected.' },
			}))
		}
	} finally {
		observe(async () => await updateExtensionIconAfterRegistrationRequestBlocks(websiteTabConnections, registration, socket, websiteOrigin))
	}
}

// Child frames publish their own website into tab state, so the tab's top-level website is its top-frame connection's when exactly one top-level website is connected. When none is, or a navigation left the previous page's port registered beside the new one, the tab's URL decides instead of connection order; undefined when neither is known.
async function getTopLevelWebsiteOrigin(websiteTabConnections: WebsiteTabConnections, tabId: number) {
	const connections = Object.values(websiteTabConnections.get(tabId)?.connections ?? {})
	const topFrameOrigins = new Set(connections.filter((connection) => isTopFramePort(connection.port)).map((connection) => connection.websiteOrigin))
	const [onlyTopFrameOrigin] = topFrameOrigins
	if (topFrameOrigins.size === 1 && onlyTopFrameOrigin !== undefined) return onlyTopFrameOrigin
	const tabUrl = (await getTabIfExists(tabId))?.url
	return tabUrl === undefined ? undefined : getHostWithPort(tabUrl)
}

// The icon reports applied request blocking, so it is refreshed once the registration's reconciliation settles, whether or not that succeeds (a failure can follow a partial rule update). A new tab always gets its first icon (call this after writing the new tab's state); an existing tab is refreshed whenever the reconciliation ran, because a consented child frame can make the whole tab blocked. A child frame's icon is resolved for the tab's top-level website, not the frame's.
export async function updateExtensionIconAfterRegistrationRequestBlocks(websiteTabConnections: WebsiteTabConnections, registration: Awaited<ReturnType<typeof registerWebsiteConnectionAndReconcileRequestBlocks>>, socket: WebsiteSocket, websiteOrigin: string) {
	const refreshIcon = async (reconciled: boolean) => {
		if (!registration.createdTabConnection && !reconciled) return
		const iconWebsiteOrigin = registration.createdTabConnection || registration.isTopFrame ? websiteOrigin : await getTopLevelWebsiteOrigin(websiteTabConnections, socket.tabId)
		// Without a known top-level website the icon is left to the tab's navigation-complete refresh.
		if (iconWebsiteOrigin !== undefined) await updateExtensionIcon(socket.tabId, iconWebsiteOrigin, bumpPopupRefreshGeneration())
	}
	let reconciled: boolean
	try {
		reconciled = await registration.requestBlocksReconciliation
	} catch (reconciliationFailure: unknown) {
		// A rejected reconciliation ran, so its tab blocking may have changed: the icon is still refreshed, and a refresh failure is reported after the reconciliation failure instead of replacing it.
		return await throwAfterFollowUp(reconciliationFailure, async () => await refreshIcon(true))
	}
	await refreshIcon(reconciled)
}

// A pure query of the blocking that is in force: only rules that were successfully applied count, and enforcement belongs to updateDeclarativeNetRequestBlocks.
export const areWeBlocking = async (tabId: number, websiteOrigin: string) => {
	const [appliedSiteBlocks, appliedTabBlocks] = await Promise.all([getAppliedSiteBlocks(), getAppliedTabBlocks()])
	return appliedSiteBlocks.includes(websiteOrigin) || appliedTabBlocks.includes(tabId)
}

export type WebsiteAccessUpdate = {
	readonly popupRefreshGeneration: number
	readonly iconRefreshTargets: readonly { readonly tabId: number, readonly websiteOrigin: string }[]
}

// One lock per connections map serializes every access reconciliation (see reconcileWebsiteApprovalAccesses). It is innermost apart from storage, request-block and RPC configuration reads, which never wait for it: its holder never prompts, reports errors, publishes popup state or takes the active-settings, access-request or RPC status publication locks, and callers may hold those while waiting for it.
const accessReconciliationLocks = new WeakMap<WebsiteTabConnections, Semaphore>()

async function withAccessReconciliationLock<Result>(websiteTabConnections: WebsiteTabConnections, run: () => Promise<Result>): Promise<Result> {
	let lock = accessReconciliationLocks.get(websiteTabConnections)
	if (lock === undefined) {
		lock = new Semaphore(1)
		accessReconciliationLocks.set(websiteTabConnections, lock)
	}
	return await lock.execute(run)
}

// The access reconciliation rule. Runs are serialized under accessReconciliationLocks. Access is granted only from the current persisted state read inside the lock: the unpinned settings snapshot (active RPC network and approvals, so connection events use the current network too) and, per connection, tab state, address book and signer state; a run that waited for the lock therefore never applies state older than an earlier run's, and the reconciliation that follows a committed write applies after every run already in flight. Anything that keeps the settings read from producing available settings (an unavailable snapshot or a rejected read) makes the run revoke-only with `committedSettings`, which the caller read after its committed write. Every connection is reconciled, and each step's failure (request-block update, a rejected settings read, active-address lookup, disconnect or connect notification) is collected independently, in order: reconcileWebsiteApprovalAccesses surfaces them itself, and the collecting variant returns them to the committed-write operation's single collector.
export async function reconcileWebsiteApprovalAccesses(
	websiteTabConnections: WebsiteTabConnections,
	committedSettings: Settings,
	throwOnError = false,
): Promise<WebsiteAccessUpdate> {
	const { update, failures } = await reconcileWebsiteApprovalAccessesCollectingFailures(websiteTabConnections, committedSettings)
	// Surfaced only after every step ran and the lock is released: thrown (first) and reported (the rest) when the caller handles failures, otherwise all reported, so none is dropped.
	await surfaceFailures(failures, reportAsUnexpectedError, { throwFirst: throwOnError })
	return update
}

// The same reconciliation for a step of a larger committed-write operation: the failures are returned, in order, for that operation's single collector (reconcileAfterIndependentSteps) to surface, instead of being reported here.
export async function reconcileWebsiteApprovalAccessesCollectingFailures(
	websiteTabConnections: WebsiteTabConnections,
	committedSettings: Settings,
): Promise<{ readonly update: WebsiteAccessUpdate, readonly failures: readonly unknown[] }> {
	const popupRefreshGeneration = bumpPopupRefreshGeneration()
	const iconRefreshTargets = new Map<string, { tabId: number, websiteOrigin: string }>()
	const failures = await withAccessReconciliationLock(websiteTabConnections, async () => {
		const runFailures: unknown[] = []
		try {
			await updateDeclarativeNetRequestBlocks(websiteTabConnections)
		} catch (error: unknown) {
			runFailures.push(error)
		}
		// This read inside the lock is authoritative: when it succeeds it may grant from the current persisted state, even if the committing operation's own earlier read-back failed, because that failure only limits what the operation publishes. When it does not, the run is revoke-only; only a rejected read is a failure of the run, while an unavailable RPC configuration is the expected state the RPC status already publishes (and an admitted operation completes under it).
		const currentSettings = await readSettingsForAccessReconciliation()
		if (currentSettings.status === 'rejected') runFailures.push(currentSettings.failure)
		const inputs: AccessReconciliationInputs = currentSettings.status === 'available'
			? { settings: currentSettings.settings, grantsAllowed: currentSettings.rpcConfigurationReady }
			: { settings: committedSettings, grantsAllowed: false }
		// Tabs are reconciled concurrently and connections of a tab in order; reconcileConnection never throws, so every connection is reconciled.
		const tabFailures = await Promise.all([...websiteTabConnections.values()].map(async (tabConnection) => {
			const connectionFailures: unknown[] = []
			for (const connection of Object.values(tabConnection.connections)) {
				addIconRefreshTarget(iconRefreshTargets, connection.socket.tabId, connection.websiteOrigin)
				connectionFailures.push(...await reconcileConnection(websiteTabConnections, connection, inputs))
			}
			return connectionFailures
		}))
		return [...runFailures, ...tabFailures.flat()]
	})
	notifyWebsiteLifecycle(websiteTabConnections.lifecycle?.accessReconciled)
	return { update: { popupRefreshGeneration, iconRefreshTargets: [...iconRefreshTargets.values()] }, failures }
}

// Call after releasing the settings lock: access dialogs can activate another address.
export async function finishWebsiteAccessUpdate(
	simulationServicesOwner: SimulationServicesOwner | undefined,
	websiteTabConnections: WebsiteTabConnections,
	update: WebsiteAccessUpdate,
	promptForAccessesIfNeeded: boolean,
	throwOnError = false,
) {
	const iconRefreshTargets = new Map<string, { tabId: number, websiteOrigin: string }>()
	for (const target of update.iconRefreshTargets) addIconRefreshTarget(iconRefreshTargets, target.tabId, target.websiteOrigin)
	if (promptForAccessesIfNeeded && simulationServicesOwner !== undefined) {
		await promptForWebsiteAccesses(simulationServicesOwner, websiteTabConnections, throwOnError)
	}
	try {
		for (const tabState of await getAllTabStates()) {
			if (websiteTabConnections.has(tabState.tabId)) continue
			if (tabState.website?.websiteOrigin === undefined) continue
			addIconRefreshTarget(iconRefreshTargets, tabState.tabId, tabState.website.websiteOrigin)
		}
		await Promise.all([...iconRefreshTargets.values()].map(({ tabId, websiteOrigin }) =>
			updateExtensionIcon(tabId, websiteOrigin, update.popupRefreshGeneration)
		))
	} catch (error) {
		if (throwOnError) throw error
		await reportUnexpectedError(error)
	}
}

export async function updateWebsiteApprovalAccesses(
	simulationServicesOwner: SimulationServicesOwner | undefined,
	websiteTabConnections: WebsiteTabConnections,
	settings: Settings,
	promptForAccessesIfNeeded: boolean,
	throwOnError = false,
): Promise<number> {
	const update = await reconcileWebsiteApprovalAccesses(websiteTabConnections, settings, throwOnError)
	await finishWebsiteAccessUpdate(simulationServicesOwner, websiteTabConnections, update, promptForAccessesIfNeeded, throwOnError)
	return update.popupRefreshGeneration
}

export async function finalizeWebsiteAccessChange(
	simulationServicesOwner: SimulationServicesOwner | undefined,
	websiteTabConnections: WebsiteTabConnections,
	settings: Settings,
	promptForAccessesIfNeeded: boolean,
): Promise<Settings> {
	// Report-and-resolve is right here: the revocation is applied before any notification can fail, so a failed notification is reported, not lost.
	await updateWebsiteApprovalAccesses(
		simulationServicesOwner,
		websiteTabConnections,
		settings,
		promptForAccessesIfNeeded,
	)
	await sendPopupMessageToOpenWindows({ method: 'popup_websiteAccess_changed' })
	return settings
}

export async function persistWebsiteAccessChange(
	simulationServicesOwner: SimulationServicesOwner | undefined,
	websiteTabConnections: WebsiteTabConnections,
	website: Website,
	access: boolean,
	address: bigint | undefined,
	promptForAccessesIfNeeded: boolean,
): Promise<Settings> {
	await setAccess(website, access, address)
	return await reconcileCommittedAccessChange(websiteTabConnections, { kind: 'website-access', websiteOrigins: [website.websiteOrigin] }, async (committedSettings) => await finalizeWebsiteAccessChange(simulationServicesOwner, websiteTabConnections, committedSettings, promptForAccessesIfNeeded))
}

// A committed write that can change website approvals, address consent, interceptor-disabled state or request blocking. Its kind, not the call site, decides which websites' runtime approvals fail closed when settings are unreadable (see getAffectedWebsites).
export type CommittedAccessChange =
	// Approvals, address consent or interceptor-disabled state of these websites.
	| { readonly kind: 'website-access', readonly websiteOrigins: readonly string[] }
	// Address-book entries, which can alter any website's effective address policy.
	| { readonly kind: 'address-book' }
	// An imported settings file, which replaces every website's approvals.
	| { readonly kind: 'settings-import' }
	// A website's request-block mode, which alters no approvals.
	| { readonly kind: 'request-block-mode' }
	// A recovered RPC configuration, whose active network decides every website's chain-specific address consent.
	| { readonly kind: 'rpc-configuration' }

type AffectedWebsites =
	| { readonly kind: 'every' }
	| { readonly kind: 'none' }
	| { readonly kind: 'websites', readonly websiteOrigins: readonly string[] }

function getAffectedWebsites(change: CommittedAccessChange): AffectedWebsites {
	switch (change.kind) {
		case 'website-access': return { kind: 'websites', websiteOrigins: change.websiteOrigins }
		case 'address-book': return { kind: 'every' }
		case 'settings-import': return { kind: 'every' }
		case 'rpc-configuration': return { kind: 'every' }
		case 'request-block-mode': return { kind: 'none' }
		default: return assertNever(change)
	}
}

const isAffectedWebsite = (affectedWebsites: AffectedWebsites, websiteOrigin: string) => {
	switch (affectedWebsites.kind) {
		case 'every': return true
		case 'none': return false
		case 'websites': return affectedWebsites.websiteOrigins.includes(websiteOrigin)
		default: return assertNever(affectedWebsites)
	}
}

// The connections of the affected websites lose their runtime approval so a committed revocation is never left unapplied, and request blocks are still reconciled (that works without an active RPC network). A failed disconnect notification or request-block update does not stop the rest; those failures are reported afterwards.
async function revokeAffectedApprovalsBecauseSettingsAreUnreadable(websiteTabConnections: WebsiteTabConnections, affectedWebsites: AffectedWebsites): Promise<readonly unknown[]> {
	// Under the reconciliation lock, so a run already in flight cannot approve a revoked connection again after it.
	return await withAccessReconciliationLock(websiteTabConnections, async () => {
		const affectedConnections = [...websiteTabConnections.values()].flatMap((tabConnection) => Object.values(tabConnection.connections)).filter((connection) => isAffectedWebsite(affectedWebsites, connection.websiteOrigin))
		const failures = affectedConnections.flatMap((connection) => disconnectIfApproved(websiteTabConnections, connection))
		try {
			await updateDeclarativeNetRequestBlocks(websiteTabConnections)
		} catch (error: unknown) {
			failures.push(error)
		}
		return failures
	})
}

// The only entry point for reconciling a committed access-affecting write: `reconcile` runs with the committed settings. When they are not available (an unavailable snapshot or a rejected read, see readSettingsForAccessReconciliation) the change's affected runtime approvals are revoked and request blocks reconciled, then that failure is thrown, and any failure of the revocation reported, without running `reconcile`.
export async function reconcileCommittedAccessChange<Result>(websiteTabConnections: WebsiteTabConnections, change: CommittedAccessChange, reconcile: (committedSettings: Settings) => Promise<Result>): Promise<Result> {
	const committedSettings = await readSettingsForAccessReconciliation()
	if (committedSettings.status !== 'available') return await surfaceFailures([committedSettings.failure, ...await revokeAffectedApprovalsBecauseSettingsAreUnreadable(websiteTabConnections, getAffectedWebsites(change))], reportAsUnexpectedError)
	return await reconcile(committedSettings.settings)
}

// The same entry point for a step of a larger committed-write operation: it never throws, and returns every failure in order (the unavailable read and the revocation's, or the failures `reconcile` returns or throws) for that operation's single collector to surface.
export async function reconcileCommittedAccessChangeCollectingFailures(websiteTabConnections: WebsiteTabConnections, change: CommittedAccessChange, reconcile: (committedSettings: Settings) => Promise<readonly unknown[]>): Promise<readonly unknown[]> {
	const committedSettings = await readSettingsForAccessReconciliation()
	if (committedSettings.status !== 'available') return [committedSettings.failure, ...await revokeAffectedApprovalsBecauseSettingsAreUnreadable(websiteTabConnections, getAffectedWebsites(change))]
	try {
		return await reconcile(committedSettings.settings)
	} catch (error: unknown) {
		return [error]
	}
}
