import { getActiveAddress, getWebsiteSocketConnection, sendPopupMessageToOpenWindows, websiteSocketToString } from './backgroundUtils.js'
import { getActiveAddressEntryForChain, getActiveAddresses } from './metadataUtils.js'
import { requestAccessFromUser } from './windows/interceptorAccess.js'
import { retrieveWebsiteDetails, updateExtensionIcon } from './iconHandler.js'
import type { TabConnection, WebsiteTabConnections } from '../types/user-interface-types.js'
import type { InpageScriptCallBack, Settings } from '../types/interceptor-messages.js'
import { getSettingsSnapshot, updateWebsiteAccess, requireReadableSettings } from './settings.js'
import { assertLiveSettingsInGrantWindow, type LiveSettings, grantWithLiveSettings } from './connectionGrant.js'
import { sendSubscriptionReplyOrCallBack } from './messageSending.js'
import type { WebsiteSocket } from '../utils/requests.js'
import { getAllTabStates } from './storageVariables.js'
import { createRpcConfigurationUnavailableError } from '../utils/rpcConfigurationError.js'
import type { Website, WebsiteAccessArray, WebsiteAddressAccess } from '../types/websiteAccessTypes.js'
import { getUniqueItemsByProperties } from '../utils/typed-arrays.js'
import { assertNever, modifyObject } from '../utils/typescript.js'
import type { AddressBookEntries, AddressBookEntry } from '../types/addressBookTypes.js'
import { Semaphore } from '../utils/semaphore.js'
import type { SimulationServicesOwner } from '../simulation/serviceLifecycle.js'
import { mergeStoredWebsiteMetadata } from '../utils/websiteIcons.js'
import { reportAsUnexpectedError, reportUnexpectedError, surfaceFailures } from '../utils/errors.js'
import { runEachIndependently } from '../utils/array.js'
import { bumpPopupRefreshGeneration } from './popupRefreshGeneration.js'
import { getActiveAddressForCurrentSignerState } from './signerStateOwnership.js'
import { getAddressBookEntriesForChainIdMorePreciseFirst } from '../utils/addressBook.js'
import { notifyWebsiteLifecycle } from './websiteLifecycle.js'
import { getWebsiteAccessForAddress, hasAccess, hasAddressAccess, type ApprovalState } from './websiteAccessPolicy.js'
import { updateDeclarativeNetRequestBlocks } from './requestBlocking.js'
import { getWebsiteActiveAddress } from './websiteActiveAddress.js'


/**
 * Connection approval and its reconciliation. Which entry point to call:
 * - A handler that committed an access-affecting write calls reconcileCommittedAccessChange with the write's CommittedAccessChange and an AccessReconciliationFollowUp that says what follows the reconciliation (prompts, error handling, popup notification). It fails closed: when the committed settings cannot be read, the change's affected approvals are revoked. persistWebsiteAccessChange is setAccess followed by it.
 * - An operation that surfaces every failure of several committed steps through one collector calls reconcileCommittedAccessChangeCollectingFailures instead, whose callback runs reconcileWebsiteApprovalAccessesCollectingFailures. accessReconciliationArchitecture.test.ts checks that handlers call the inner reconciliation functions only inside that callback.
 * - updateWebsiteApprovalAccesses reconciles without a committed write (follow-up prompts after an access dialog); the entry points above run it.
 * The CommittedAccessChange taxonomy and its fail-closed scope (getAffectedWebsites) stay with the reconciliation that applies them: when committed settings are unreadable, the scope decides which connections lose their approval, under the same reconciliation lock that grants. Keeping the scope private here means no caller can revoke a narrower scope than its change implies; the architecture test checks that it stays private.
 */

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

// Can approve the connection and announce the settings' chain to the page, so it takes LiveSettings, which only grantWithLiveSettings's synchronous grant receives.
export function verifyAccess(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, askAccessIfUnknown: boolean, websiteOrigin: string, requestAccessForAddress: AddressBookEntry | undefined, settings: LiveSettings, options: VerifyAccessOptions = {}): ApprovalState {
	assertLiveSettingsInGrantWindow(settings)
	const connection = getWebsiteSocketConnection(websiteTabConnections, socket)
	if (connection?.approved && options.ignoreConnectionApproval !== true) return 'hasAccess'
	const access = requestAccessForAddress !== undefined ? hasAddressAccess(settings.websiteAccess, websiteOrigin, requestAccessForAddress) : hasAccess(settings.websiteAccess, websiteOrigin)
	if (access === 'hasAccess') {
		const popupRefreshGeneration = bumpPopupRefreshGeneration()
		const grantFollowUps = connectToPort(
			websiteTabConnections,
			socket,
			settings,
			requestAccessForAddress?.address,
		)
		// No caller waits for these, so their failures are reported here; the icon follows the reconciled blocks whether or not the follow-ups failed.
		void (async () => {
			const failures = await runEachIndependently([async () => await grantFollowUps, async () => await updateExtensionIcon(socket.tabId, websiteOrigin, popupRefreshGeneration)], async (step) => await step())
			await surfaceFailures(failures, reportAsUnexpectedError, { throwFirst: false })
		})()
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

const collectFailure = (step: () => void): readonly unknown[] => {
	try {
		step()
		return []
	} catch (error: unknown) {
		return [error]
	}
}

// The only code that approves a connection. The grant is synchronous, and so are its notifications, which the page must see before any reply. A newly approved tab can also need a block that no update installed yet. Neither follow-up can skip the other: the returned promise settles once request blocks are reconciled, and rejects with the first failure after reporting the rest.
function connectToPort(
	websiteTabConnections: WebsiteTabConnections,
	socket: WebsiteSocket,
	settings: LiveSettings,
	connectWithActiveAddress: bigint | undefined,
): Promise<void> {
	assertLiveSettingsInGrantWindow(settings)
	const wasApproved = getWebsiteSocketConnection(websiteTabConnections, socket)?.approved === true
	setWebsitePortApproval(websiteTabConnections, socket, true)
	if (!wasApproved) notifyWebsiteLifecycle(websiteTabConnections.lifecycle?.approvalChanged, socket, true)
	const notificationFailures = collectFailure(() => { if (shouldSendUnscopedConnectionEvents(socket)) sendProviderConnectionEventsToPort(websiteTabConnections, socket, settings, connectWithActiveAddress === undefined ? [] : [connectWithActiveAddress]) })
	return (async () => {
		const blockFailures = await runEachIndependently([async () => { if (!wasApproved) await updateDeclarativeNetRequestBlocks(websiteTabConnections) }], async (step) => await step())
		await surfaceFailures([...notificationFailures, ...blockFailures], reportAsUnexpectedError)
	})()
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

const getConnectionAccessForAddress = (websiteAccess: WebsiteAccessArray, connection: WebsiteConnection, activeAddress: AddressBookEntry | undefined) => getWebsiteAccessForAddress(websiteAccess, connection.websiteOrigin, activeAddress)

async function getConnectionAccess(websiteTabConnections: WebsiteTabConnections, connection: WebsiteConnection, settings: Settings) {
	const activeAddress = await getConnectionActiveAddress(websiteTabConnections, connection, settings)
	return { activeAddress, access: getConnectionAccessForAddress(settings.websiteAccess, connection, activeAddress) }
}

// The current persisted settings: active RPC network, active-address fields and approvals. Anything that keeps them from being available is returned instead of thrown, with the failure a committed write's entry point surfaces: an `unavailable` snapshot (the RPC configuration is unavailable, an expected state the RPC status publishes) as the RPC-configuration-unavailable error, and a `rejected` read (an unexpected failure, for example a failed repair write of a corrupt field) as its rejection.
type AccessReconciliationSettingsRead =
	| { readonly status: 'available', readonly settings: Settings }
	| { readonly status: 'unavailable' | 'rejected', readonly failure: unknown }

async function readSettingsForAccessReconciliation(): Promise<AccessReconciliationSettingsRead> {
	try {
		const snapshot = await getSettingsSnapshot()
		if (snapshot.status === 'available') return { status: 'available', settings: snapshot.settings }
	} catch (error: unknown) {
		return { status: 'rejected', failure: error }
	}
	return { status: 'unavailable', failure: createRpcConfigurationUnavailableError() }
}

// What one reconciliation run applies: the current settings read inside the lock, which may grant (each grant still rechecks them immediately before it, see reconcileConnection), or (when they are unavailable) the caller's committed settings, which may only revoke.
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
		// The active-address lookup and the connections before this one awaited, so the grant is decided on a fresh read. connectToPort approves synchronously; its request-block update is returned and awaited after the grant.
		const grant = await grantWithLiveSettings(inputs.settings, (liveSettings) => {
			if (connection.approved || getConnectionAccessForAddress(liveSettings.websiteAccess, connection, activeAddress) !== 'hasAccess') return undefined
			return { blocksUpdated: connectToPort(websiteTabConnections, connection.socket, liveSettings, activeAddress?.address) }
		})
		if (grant.kind === 'granted' && grant.result !== undefined) await grant.result.blocksUpdated
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
				const settings = requireReadableSettings(await getSettingsSnapshot())
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

export type WebsiteAccessUpdate = {
	readonly popupRefreshGeneration: number
	readonly iconRefreshTargets: readonly { readonly tabId: number, readonly websiteOrigin: string }[]
}

// One lock per connections map serializes every access reconciliation (see reconcileWebsiteApprovalAccessesCollectingFailures). It is innermost apart from storage, request-block and RPC configuration reads, which never wait for it: its holder never prompts, reports errors, publishes popup state or takes the active-settings, access-request or RPC status publication locks, and callers may hold those while waiting for it.
const accessReconciliationLocks = new WeakMap<WebsiteTabConnections, Semaphore>()

async function withAccessReconciliationLock<Result>(websiteTabConnections: WebsiteTabConnections, run: () => Promise<Result>): Promise<Result> {
	let lock = accessReconciliationLocks.get(websiteTabConnections)
	if (lock === undefined) {
		lock = new Semaphore(1)
		accessReconciliationLocks.set(websiteTabConnections, lock)
	}
	return await lock.execute(run)
}

// The access reconciliation rule. Runs are serialized under accessReconciliationLocks. Access is granted only from the current persisted state read inside the lock: the unpinned settings snapshot (active RPC network and approvals, so connection events use the current network too) and, per connection, tab state, address book and signer state; a run that waited for the lock therefore never applies state older than an earlier run's, and the reconciliation that follows a committed write applies after every run already in flight. Anything that keeps the settings read from producing available settings (an unavailable snapshot or a rejected read) makes the run revoke-only with `committedSettings`, which the caller read after its committed write. Every connection is reconciled, and each step's failure (request-block update, a rejected settings read, active-address lookup, disconnect or connect notification) is collected independently, in order: this function surfaces them itself, and the collecting variant returns them to the committed-write operation's single collector.
async function reconcileWebsiteApprovalAccesses(
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
			? { settings: currentSettings.settings, grantsAllowed: true }
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
		// Blocks are updated again once the connections are reconciled. Tab blocking fails closed on approved connections (tabHasApprovedOrConsentedConnection in requestBlocking.ts), so the update above kept the block of a tab whose connection this run disconnects; it is lifted only here, when the connection can no longer make requests. Unchanged blocks are not rewritten.
		try {
			await updateDeclarativeNetRequestBlocks(websiteTabConnections)
		} catch (error: unknown) {
			runFailures.push(error)
		}
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

// Reconciles every connection with `settings`, then runs the access prompts and icon updates. Handlers reach it through reconcileCommittedAccessChange; it is called directly only where no access write was committed (follow-up prompts after an access dialog).
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

export async function persistWebsiteAccessChange(
	simulationServicesOwner: SimulationServicesOwner | undefined,
	websiteTabConnections: WebsiteTabConnections,
	website: Website,
	access: boolean,
	address: bigint | undefined,
	promptForAccessesIfNeeded: boolean,
): Promise<Settings> {
	await setAccess(website, access, address)
	return await reconcileCommittedAccessChange(websiteTabConnections, { kind: 'website-access', websiteOrigins: [website.websiteOrigin] }, { simulationServicesOwner, promptForAccesses: promptForAccessesIfNeeded, throwOnError: false, notifyWebsiteAccessChanged: true })
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

// What follows the reconciliation of a committed access change, chosen by the handler instead of a reconciliation variant.
export type AccessReconciliationFollowUp = {
	readonly simulationServicesOwner: SimulationServicesOwner | undefined
	// Opens access prompts for websites that now need a decision.
	readonly promptForAccesses: boolean
	// Throws the first failure to the caller instead of reporting every failure.
	readonly throwOnError: boolean
	// Tells open popups that website access changed, after the reconciliation is applied.
	readonly notifyWebsiteAccessChanged: boolean
}

// The entry point for reconciling a committed access-affecting write: the reconciliation runs with the committed settings, read now, and then `followUp`. When they are not available (an unavailable snapshot or a rejected read, see readSettingsForAccessReconciliation) the change's affected runtime approvals are revoked and request blocks reconciled, then that failure is thrown, and any failure of the revocation reported.
export async function reconcileCommittedAccessChange(websiteTabConnections: WebsiteTabConnections, change: CommittedAccessChange, followUp: AccessReconciliationFollowUp): Promise<Settings> {
	const committedSettings = await readSettingsForAccessReconciliation()
	if (committedSettings.status !== 'available') return await surfaceFailures([committedSettings.failure, ...await revokeAffectedApprovalsBecauseSettingsAreUnreadable(websiteTabConnections, getAffectedWebsites(change))], reportAsUnexpectedError)
	await updateWebsiteApprovalAccesses(followUp.simulationServicesOwner, websiteTabConnections, committedSettings.settings, followUp.promptForAccesses, followUp.throwOnError)
	// Sent after the revocation is applied, so a failed notification is reported, not lost.
	if (followUp.notifyWebsiteAccessChanged) await sendPopupMessageToOpenWindows({ method: 'popup_websiteAccess_changed' })
	return committedSettings.settings
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
