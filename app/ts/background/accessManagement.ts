import { backgroundTaskSupervisor } from './backgroundTasks.js'
import { getActiveAddress, getWebsiteSocketConnection, sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { getActiveAddressEntryForChain, getActiveAddresses } from './metadataUtils.js'
import { requestAccessFromUser } from './windows/interceptorAccess.js'
import { retrieveWebsiteDetails, updateExtensionIcon } from './iconHandler.js'
import type { TabConnection, WebsiteTabConnections } from '../types/user-interface-types.js'
import type { Settings } from '../types/interceptor-messages.js'
import { getSettingsSnapshot, updateWebsiteAccess, updateWebsiteAccessWithSnapshots } from './settings.js'
import { getWebsiteApprovalChangedOrigins, type CommittedWebsiteAccessChange } from './websiteAccessState.js'
import { grantWithLiveSettings } from './connectionGrant.js'
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
import { getWebsiteAccessForAddress, hasAccess, hasAddressAccess, type ApprovalState, settingsIfRpcConfigurationReady, type ReadyRpcSettings } from './websiteAccessPolicy.js'
import { updateDeclarativeNetRequestBlocks } from './requestBlocking.js'
import { shouldSendUnscopedConnectionEvents } from './websiteConnectionEvents.js'


/**
 * Connection approval and its reconciliation. Which entry point to call:
 * - A handler that committed an access-affecting write calls reconcileCommittedAccessChangeOrFailClosed with the write's CommittedAccessChange and an AccessReconciliationFollowUp that says what follows the reconciliation (prompts and popup notification). It fails closed: when the committed settings cannot be read, the change's affected approvals are revoked. persistWebsiteAccessChange is setAccess followed by it.
 * - updateWebsiteApprovalAccesses reconciles without a committed write (follow-up prompts after an access dialog); the entry points above run it.
 * The CommittedAccessChange taxonomy and its fail-closed scope (getAffectedWebsites) stay with the reconciliation that applies them: when committed settings are unreadable, the scope decides which connections lose their approval, under the same reconciliation lock that grants. The owner derives website scope from complete committed snapshots; callers cannot select origins or claim that an edit changed no authority.
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

type VerifyAccessOptions = {
	readonly ignoreConnectionApproval?: boolean
}

export async function verifyAccess(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, askAccessIfUnknown: boolean, websiteOrigin: string, requestAccessForAddress: AddressBookEntry | undefined, settings: Settings, options: VerifyAccessOptions = {}): Promise<ApprovalState> {
	const connection = getWebsiteSocketConnection(websiteTabConnections, socket)
	if (connection?.approved && options.ignoreConnectionApproval !== true) return 'hasAccess'
	const getAccess = (current: Settings) => requestAccessForAddress !== undefined
		? hasAddressAccess(current.websiteAccess, websiteOrigin, requestAccessForAddress)
		: hasAccess(current.websiteAccess, websiteOrigin)
	const access = getAccess(settings)
	if (access === 'noAccess' || access === 'interceptorDisabled') return access
	if (access === 'askAccess') return askAccessIfUnknown ? 'askAccess' : 'noAccess'

	const grant = await grantWithLiveSettings(settings, (liveSettings) => {
		if (getWebsiteSocketConnection(websiteTabConnections, socket) !== connection) return { access: 'noAccess' as const }
		const liveAccess = getAccess(liveSettings)
		if (liveAccess !== 'hasAccess') return { access: liveAccess }
		return { access: liveAccess, followUpFailures: connectToPort(websiteTabConnections, socket, liveSettings, requestAccessForAddress?.address) }
	})
	if (grant.kind !== 'granted') return 'noAccess'
	const { access: liveAccess, followUpFailures } = grant.result
	if (followUpFailures !== undefined) {
		const popupRefreshGeneration = bumpPopupRefreshGeneration()
		backgroundTaskSupervisor.start({ source: 'website_connection_grant' }, async () => {
			const failures = await followUpFailures
			const iconFailures = await runEachIndependently([socket.tabId], async (tabId) => await updateExtensionIcon(websiteTabConnections, tabId, websiteOrigin, popupRefreshGeneration))
			await surfaceFailures([...failures, ...iconFailures], reportAsUnexpectedError, { throwFirst: false })
		})
	}
	return liveAccess === 'askAccess' && !askAccessIfUnknown ? 'noAccess' : liveAccess
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

const accessDecision = (website: Website, access: boolean, address: bigint | undefined) => (previousWebsiteAccess: WebsiteAccessArray): WebsiteAccessArray => {
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
}

export async function setAccess(website: Website, access: boolean, address: bigint | undefined) {
	return await updateWebsiteAccess(accessDecision(website, access, address))
}

const collectFailure = (step: () => void): readonly unknown[] => {
	try {
		step()
		return []
	} catch (error: unknown) {
		return [error]
	}
}

// The only code that approves a connection. The grant is synchronous, and so are its notifications, which the page must see before any reply. A newly approved tab can also need a block that no update installed yet. Neither follow-up can skip the other: the returned promise settles once request blocks are reconciled, and returns any failures for the caller to handle.
function connectToPort(
	websiteTabConnections: WebsiteTabConnections,
	socket: WebsiteSocket,
	settings: ReadyRpcSettings,
	connectWithActiveAddress: bigint | undefined,
): Promise<readonly unknown[]> {
	const wasApproved = getWebsiteSocketConnection(websiteTabConnections, socket)?.approved === true
	setWebsitePortApproval(websiteTabConnections, socket, true)
	if (!wasApproved) notifyWebsiteLifecycle(websiteTabConnections.lifecycle?.approvalChanged, socket, true)
	const notificationFailures = collectFailure(() => { if (shouldSendUnscopedConnectionEvents(socket)) sendProviderConnectionEventsToPort(websiteTabConnections, socket, settings, connectWithActiveAddress === undefined ? [] : [connectWithActiveAddress]) })
	return (async () => {
		const blockFailures = await runEachIndependently([async () => { if (!wasApproved) await updateDeclarativeNetRequestBlocks(websiteTabConnections) }], async (step) => await step())
		return [...notificationFailures, ...blockFailures]
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
		if (snapshot.websiteApprovals.status === 'unreadable') return { status: 'rejected', failure: snapshot.websiteApprovals.error }
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
async function reconcileConnection(websiteTabConnections: WebsiteTabConnections, connection: WebsiteConnection, inputs: AccessReconciliationInputs, newlyGranted: Set<WebsiteConnection>): Promise<readonly unknown[]> {
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
			if (getWebsiteSocketConnection(websiteTabConnections, connection.socket) !== connection) return undefined
			if (connection.approved || getConnectionAccessForAddress(liveSettings.websiteAccess, connection, activeAddress) !== 'hasAccess') return undefined
			newlyGranted.add(connection)
			return { followUpFailures: connectToPort(websiteTabConnections, connection.socket, liveSettings, activeAddress?.address) }
		})
		if (grant.kind === 'granted' && grant.result !== undefined) {
			const failures = await grant.result.followUpFailures
			if (failures.length > 0) return [...failures, ...disconnectIfApproved(websiteTabConnections, connection)]
		}
		return []
	} catch (error: unknown) {
		return [error, ...disconnectIfApproved(websiteTabConnections, connection)]
	}
}

// Awaited; reports each failed prompt and continues with the next connection.
async function promptForWebsiteAccesses(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections): Promise<void> {
	for (const tabConnection of websiteTabConnections.values()) {
		for (const connection of Object.values(tabConnection.connections)) {
			if (!connection.wantsToConnect) continue
			try {
				// Reconciliation uses the committed snapshot; deferred prompts must recheck the latest settings.
				const settings = settingsIfRpcConfigurationReady(await getSettingsSnapshot())
				if (settings === undefined) continue
				const { activeAddress, access } = await getConnectionAccess(websiteTabConnections, connection, settings)
				if (access !== 'askAccess') continue
				await askUserForAccessOnConnectionUpdate(simulationServicesOwner, websiteTabConnections, connection.socket, connection.websiteOrigin, activeAddress, settings)
			} catch (error) {
				await reportUnexpectedError(error, { source: 'website_access_prompt', details: { websiteOrigin: connection.websiteOrigin, socket: connection.socket } })
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
export async function reconcileWebsiteApprovalAccesses(
	websiteTabConnections: WebsiteTabConnections,
	committedSettings: Settings,
): Promise<WebsiteAccessUpdate> {
	const { update, failures } = await reconcileWebsiteApprovalAccessesCollectingFailures(websiteTabConnections, committedSettings)
	// Report after every step ran and the lock is released; committed-write callers collect the same run and propagate its failures instead.
	await surfaceFailures(failures, reportAsUnexpectedError, { throwFirst: false })
	return update
}

// The shared reconciliation run returns failures without throwing under the lock. Each named entry point owns reporting or propagation after the lock is released.
async function reconcileWebsiteApprovalAccessesCollectingFailures(
	websiteTabConnections: WebsiteTabConnections,
	committedSettings: Settings,
): Promise<{ readonly update: WebsiteAccessUpdate, readonly failures: readonly unknown[] }> {
	const popupRefreshGeneration = bumpPopupRefreshGeneration()
	const iconRefreshTargets = new Map<string, { tabId: number, websiteOrigin: string }>()
	const failures = await withAccessReconciliationLock(websiteTabConnections, async () => {
		const runFailures: unknown[] = []
		const newlyGranted = new Set<WebsiteConnection>()
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
				connectionFailures.push(...await reconcileConnection(websiteTabConnections, connection, inputs, newlyGranted))
			}
			return connectionFailures
		}))
		// Blocks are updated again once the connections are reconciled. Tab blocking fails closed on approved connections (tabHasApprovedOrConsentedConnection in requestBlocking.ts), so the update above kept the block of a tab whose connection this run disconnects; it is lifted only here, when the connection can no longer make requests. Unchanged blocks are not rewritten.
		try {
			await updateDeclarativeNetRequestBlocks(websiteTabConnections)
		} catch (error: unknown) {
			runFailures.push(error)
		}
		const failures = [...runFailures, ...tabFailures.flat()]
		// An unsuccessful run withdraws its own grants, even if a different tab finished granting after another tab failed. Unrelated approvals keep their authority.
		if (failures.length > 0) {
			for (const connection of newlyGranted) failures.push(...disconnectIfApproved(websiteTabConnections, connection))
		}
		return failures
	})
	notifyWebsiteLifecycle(websiteTabConnections.lifecycle?.accessReconciled)
	return { update: { popupRefreshGeneration, iconRefreshTargets: [...iconRefreshTargets.values()] }, failures }
}

// Awaited prompt and icon work, reporting failures; module-private so callers choose between startWebsiteAccessUiUpdateInBackground and updateWebsiteApprovalAccesses. Runs after the settings lock is released, because access dialogs can activate another address.
async function finishWebsiteAccessUpdate(
	simulationServicesOwner: SimulationServicesOwner | undefined,
	websiteTabConnections: WebsiteTabConnections,
	update: WebsiteAccessUpdate,
	promptForAccessesIfNeeded: boolean,
): Promise<void> {
	const iconRefreshTargets = new Map<string, { tabId: number, websiteOrigin: string }>()
	for (const target of update.iconRefreshTargets) addIconRefreshTarget(iconRefreshTargets, target.tabId, target.websiteOrigin)
	if (promptForAccessesIfNeeded && simulationServicesOwner !== undefined) {
		await promptForWebsiteAccesses(simulationServicesOwner, websiteTabConnections)
	}
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
		await reportUnexpectedError(error, { source: 'website_access_icons', details: { popupRefreshGeneration: update.popupRefreshGeneration } })
	}
}

// Reconciles every connection with `settings`, then runs the access prompts and icon updates. Handlers reach it through reconcileCommittedAccessChangeOrFailClosed; it is called directly only where no access write was committed (follow-up prompts after an access dialog).
export async function updateWebsiteApprovalAccesses(
	simulationServicesOwner: SimulationServicesOwner | undefined,
	websiteTabConnections: WebsiteTabConnections,
	settings: Settings,
	promptForAccessesIfNeeded: boolean,
): Promise<number> {
	const update = await reconcileWebsiteApprovalAccesses(websiteTabConnections, settings)
	await finishWebsiteAccessUpdate(simulationServicesOwner, websiteTabConnections, update, promptForAccessesIfNeeded)
	return update.popupRefreshGeneration
}

// Not awaited; starts the prompt and icon work for a finished reconciliation as a background task that reports its own failures, so a local command can reply without waiting for prompts.
export function startWebsiteAccessUiUpdateInBackground(
	simulationServicesOwner: SimulationServicesOwner | undefined,
	websiteTabConnections: WebsiteTabConnections,
	update: WebsiteAccessUpdate,
	promptForAccessesIfNeeded: boolean,
): void {
	backgroundTaskSupervisor.start({ source: 'website_access_ui', details: { popupRefreshGeneration: update.popupRefreshGeneration } },
		async () => await finishWebsiteAccessUpdate(simulationServicesOwner, websiteTabConnections, update, promptForAccessesIfNeeded))
}

export async function persistWebsiteAccessChange(
	simulationServicesOwner: SimulationServicesOwner | undefined,
	websiteTabConnections: WebsiteTabConnections,
	website: Website,
	access: boolean,
	address: bigint | undefined,
	promptForAccessesIfNeeded: boolean,
): Promise<Settings> {
	const committedChange = await updateWebsiteAccessWithSnapshots(accessDecision(website, access, address))
	return await reconcileCommittedAccessChangeOrFailClosed(websiteTabConnections, { kind: 'website-access', committedChange }, { simulationServicesOwner, promptForAccesses: promptForAccessesIfNeeded, notifyWebsiteAccessChanged: true })
}

// A committed write that can change website approvals, address consent, interceptor-disabled state or request blocking. Its kind, not the call site, decides which websites' runtime approvals fail closed when settings are unreadable (see getAffectedWebsites).
export type CommittedAccessChange =
	// The complete committed or rolled-back snapshots; missing metadata conservatively affects every website.
	| { readonly kind: 'website-access', readonly committedChange?: CommittedWebsiteAccessChange }
	// Address-book entries, which can alter any website's effective address policy.
	| { readonly kind: 'address-book' }
	// An imported settings file, which replaces every website's approvals.
	| { readonly kind: 'settings-import' }
	// A recovered RPC configuration, whose active network decides every website's chain-specific address consent.
	| { readonly kind: 'rpc-configuration' }

type AffectedWebsites =
	| { readonly kind: 'every' }
	| { readonly kind: 'none' }
	| { readonly kind: 'websites', readonly websiteOrigins: readonly string[] }

function getAffectedWebsites(change: CommittedAccessChange): AffectedWebsites {
	switch (change.kind) {
		case 'website-access': {
			if (change.committedChange === undefined) return { kind: 'every' }
			const origins = getWebsiteApprovalChangedOrigins(change.committedChange.previousWebsiteAccess, change.committedChange.updatedWebsiteAccess)
			return origins.length === 0 ? { kind: 'none' } : { kind: 'websites', websiteOrigins: origins }
		}
		case 'address-book': return { kind: 'every' }
		case 'settings-import': return { kind: 'every' }
		case 'rpc-configuration': return { kind: 'every' }
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
async function revokeAffectedApprovalsAfterReconciliationFailure(websiteTabConnections: WebsiteTabConnections, affectedWebsites: AffectedWebsites): Promise<readonly unknown[]> {
	// Under the reconciliation lock, so a run already in flight cannot approve a revoked connection again after it.
	return await withAccessReconciliationLock(websiteTabConnections, async () => {
		const affectedConnections = [...websiteTabConnections.values()].flatMap((tabConnection) => Object.values(tabConnection.connections)).filter((connection) => isAffectedWebsite(affectedWebsites, connection.websiteOrigin))
		const previouslyApproved = new Set(affectedConnections.filter((connection) => connection.approved))
		for (const connection of affectedConnections) connection.approved = false
		const failures = affectedConnections.flatMap((connection) => collectFailure(() => {
			if (previouslyApproved.has(connection)) disconnectFromPort(websiteTabConnections, connection.socket)
			else notifyWebsiteLifecycle(websiteTabConnections.lifecycle?.approvalChanged, connection.socket, false)
		}))
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
	// Tells open popups that website access changed, after the reconciliation is applied.
	readonly notifyWebsiteAccessChanged: boolean
	readonly uiCompletion?: 'background'
}

function refreshIconsAfterFailedReconciliation(websiteTabConnections: WebsiteTabConnections) {
	startWebsiteAccessUiUpdateInBackground(undefined, websiteTabConnections, {
		popupRefreshGeneration: bumpPopupRefreshGeneration(),
		iconRefreshTargets: [...websiteTabConnections.values()].flatMap((tab) => Object.values(tab.connections).map(({ socket, websiteOrigin }) => ({ tabId: socket.tabId, websiteOrigin }))),
	}, false)
}

async function reconcileCommittedAccessState(websiteTabConnections: WebsiteTabConnections, change: CommittedAccessChange) {
	const committedSettings = await readSettingsForAccessReconciliation()
	if (committedSettings.status !== 'available') {
		const failures = [committedSettings.failure, ...await revokeAffectedApprovalsAfterReconciliationFailure(websiteTabConnections, getAffectedWebsites(change))]
		refreshIconsAfterFailedReconciliation(websiteTabConnections)
		await surfaceFailures(failures.slice(1), reportAsUnexpectedError, { throwFirst: false })
		throw committedSettings.failure
	}
	try {
		const { update, failures } = await reconcileWebsiteApprovalAccessesCollectingFailures(websiteTabConnections, committedSettings.settings)
		await surfaceFailures(failures, reportAsUnexpectedError)
		return { settings: committedSettings.settings, update }
	} catch (error: unknown) {
		const failures = await revokeAffectedApprovalsAfterReconciliationFailure(websiteTabConnections, getAffectedWebsites(change))
		refreshIconsAfterFailedReconciliation(websiteTabConnections)
		await surfaceFailures(failures, reportAsUnexpectedError, { throwFirst: false })
		throw error
	}
}

// Compatibility for current main's local edits: await authority reconciliation, with prompts/icons explicitly scheduled by its callers.
export async function reconcileCommittedWebsiteAccessOrFailClosed(websiteTabConnections: WebsiteTabConnections): Promise<WebsiteAccessUpdate> {
	return (await reconcileCommittedAccessState(websiteTabConnections, { kind: 'address-book' })).update
}

// The entry point for reconciling a committed access-affecting write: the reconciliation runs with the committed settings, read now, and then `followUp`. When they are not available (an unavailable snapshot or a rejected read, see readSettingsForAccessReconciliation) the change's affected runtime approvals are revoked and request blocks reconciled, then that failure is thrown, and any failure of the revocation reported.
export async function reconcileCommittedAccessChangeOrFailClosed(websiteTabConnections: WebsiteTabConnections, change: CommittedAccessChange, followUp: AccessReconciliationFollowUp): Promise<Settings> {
	const { settings, update } = await reconcileCommittedAccessState(websiteTabConnections, change)
	if (followUp.uiCompletion === 'background') startWebsiteAccessUiUpdateInBackground(followUp.simulationServicesOwner, websiteTabConnections, update, followUp.promptForAccesses)
	else await finishWebsiteAccessUpdate(followUp.simulationServicesOwner, websiteTabConnections, update, followUp.promptForAccesses)
	if (followUp.notifyWebsiteAccessChanged) await sendPopupMessageToOpenWindows({ method: 'popup_websiteAccess_changed' })
	return settings
}
