import { METAMASK_ERROR_ALREADY_PENDING } from '../../utils/constants.js'
import { Future } from '../../utils/future.js'
import type { InterceptorAccessChangeAddress, InterceptorAccessRefresh, InterceptorAccessReply, Settings, WindowMessage } from '../../types/interceptor-messages.js'
import { createScopedKeyedSerialExecutor, Semaphore } from '../../utils/semaphore.js'
import type { WebsiteTabConnections } from '../../types/user-interface-types.js'
import { getAssociatedAddresses, verifyAccess, withSuppressedUnscopedConnectionEventsForSocket, withSuppressedUnscopedConnectionEventsForSocketAsync } from '../accessManagement.js'
import { INTERNAL_CHANNEL_NAME, createInternalMessageListener, getHtmlFile, sendPopupMessageToOpenWindows, websiteSocketToString } from '../backgroundUtils.js'
import { getActiveAddressEntryForChain, getActiveAddresses, getWalletActiveAddressEntryForChain } from '../metadataUtils.js'
import { getSettings } from '../settings.js'
import { getTabState, updatePendingAccessRequests, getPendingAccessRequests, clearPendingAccessRequests } from '../storageVariables.js'
import { doesUniqueRequestIdentifiersMatch, type InterceptedRequest, type WebsiteSocket } from '../../utils/requests.js'
import { refuseAccess, replyToInterceptedRequest, sendSubscriptionReplyOrCallBackToPort } from '../messageSending.js'
import type { PopupOrTabId, Website, WebsiteAccessArray } from '../../types/websiteAccessTypes.js'
import type { PendingAccessRequest } from '../../types/accessRequest.js'
import { doAddressBookChainIdsMatch, type AddressBookEntries, type AddressBookEntry } from '../../types/addressBookTypes.js'
import { type PopupOrTab, addWindowTabListeners, closePopupOrTabById, getPopupOrTabById, openPopupOrTab, removeWindowTabListeners, tryFocusingTabOrWindow } from '../../utils/popupOrTab.js'
import { isAccountConnectionMethod } from '../accountRequestMethods.js'
import type { ErrorWithCodeAndOptionalData } from '../../types/error.js'
import { getConfirmedSignerStateToken, isSignerStateTokenCurrent, signerConnectionReplacedError, signerUnavailableError, tabHasApprovedWebsiteConnection, waitForConfirmedSignerStateToken } from '../signerStateOwnership.js'
import { assertActiveAddressSelectionAllowed, includePersistedAddressBookEntry } from '../../utils/activeAddressSelection.js'

type OpenedDialogWithListeners = {
	popupOrTab: PopupOrTab
	onClosePopup: (id: number) => void
	onCloseTab: (id: number) => void
} | undefined

let openedDialog: OpenedDialogWithListeners 

const pendingInterceptorAccessSemaphore = new Semaphore(1)
// Signer account replies identify the tab-wide signer owner but not the originating request. Keep one round trip active per tab so requests from sibling frames cannot settle each other.
const serializeSignerAccountRequest = createScopedKeyedSerialExecutor<WebsiteTabConnections, number>()
const SIGNER_ACCOUNT_REPLY_TIMEOUT_MS = 5_000

export type SignerAccountRefreshOptions = {
	readonly passiveReplyTimeoutMs?: number
}

type SignerAccountsRequestResult = {
	readonly accounts: readonly bigint[]
	readonly error: ErrorWithCodeAndOptionalData | undefined
}

const signerAccountReplyTimeoutError = {
	code: signerUnavailableError.code,
	message: 'Signer wallet did not respond to the account request.',
}

async function waitForSignerAccountReply(future: Future<ErrorWithCodeAndOptionalData | undefined>, timeoutMs: number) {
	let timeout: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			Promise.resolve(future),
			new Promise<ErrorWithCodeAndOptionalData>((resolve) => {
				timeout = setTimeout(() => resolve(signerAccountReplyTimeoutError), timeoutMs)
			}),
		])
	} finally {
		if (timeout !== undefined) clearTimeout(timeout)
	}
}

const onCloseWindowOrTab = async (popupOrTabs: PopupOrTabId, websiteTabConnections: WebsiteTabConnections) => await pendingInterceptorAccessSemaphore.execute(async () => { // check if user has closed the window on their own, if so, reject the queued requests
	if (openedDialog === undefined || openedDialog.popupOrTab.id !== popupOrTabs.id || openedDialog.popupOrTab.type !== popupOrTabs.type) return
	removeWindowTabListeners(openedDialog.onClosePopup, openedDialog.onCloseTab)

	openedDialog = undefined
	for (const pendingRequest of await clearPendingAccessRequests()) {
		if (pendingRequest.request !== undefined) refuseAccess(websiteTabConnections, pendingRequest.request)
	}
})

export type InterceptedRequestReplay = {
	readonly website: Website
	readonly socket: WebsiteSocket
	readonly request: InterceptedRequest
}

// Sends a request that waited for access back through the RPC router. Callers inject it because the router depends on this dialog.
export type ReplayInterceptedRequest = (replay: InterceptedRequestReplay) => Promise<unknown>

// Persists an approved or rejected reply and activates a newly selected address. Callers inject it because settings transitions depend on this dialog.
export type ApplyInterceptorAccessReply = (accessReply: InterceptorAccessReply, pendingAccessRequest: PendingAccessRequest, userRequestedAddressChange: boolean) => Promise<void>

export type InterceptorAccessReplySettlement = {
	readonly pendingRequestsToReplay: readonly InterceptedRequestReplay[]
	readonly promptForFollowUpAccesses: boolean
	readonly replayRequestSocket: WebsiteSocket | undefined
}

// Applies the user's reply to its pending access request under the dialog lock, removes every request the reply answers, and closes the dialog when none remain.
export async function settleInterceptorAccessReply(websiteTabConnections: WebsiteTabConnections, reply: InterceptorAccessReply, applyAccessReply: ApplyInterceptorAccessReply): Promise<InterceptorAccessReplySettlement> {
	return await pendingInterceptorAccessSemaphore.execute(async () => {
		const promises = await getPendingAccessRequests()
		const pendingRequest = promises.find((req) => req.accessRequestId === reply.accessRequestId)
		if (pendingRequest === undefined) throw new Error('Access request missing!')
		const replyWithPendingRequestAddresses = {
			...reply,
			requestAccessToAddress: reply.requestAccessToAddress ?? pendingRequest.requestAccessToAddress?.address,
			originalRequestAccessToAddress: reply.originalRequestAccessToAddress ?? pendingRequest.originalRequestAccessToAddress?.address,
		}
		return {
			...await resolve(websiteTabConnections, replyWithPendingRequestAddresses, pendingRequest, applyAccessReply),
			replayRequestSocket: pendingRequest.request !== undefined && isAccountConnectionMethod(pendingRequest.request.method)
				? pendingRequest.request.uniqueRequestIdentifier.requestSocket
				: undefined,
		}
	})
}

export async function getAddressMetadataForAccess(websiteAccess: WebsiteAccessArray, chainId: bigint): Promise<AddressBookEntries> {
	const addresses = websiteAccess.flatMap((x) => x.addressAccess === undefined ? [] : x.addressAccess?.map((addr) => addr.address))
	const addressSet = new Set(addresses)
	return await Promise.all(Array.from(addressSet).map((x) => getActiveAddressEntryForChain(x, chainId)))
}

export function filterAccessDialogAddressesForChain(activeAddresses: AddressBookEntries, chainId: bigint) {
	return activeAddresses.filter((entry) => entry.type !== 'safe' || entry.chainId === chainId)
}

async function getAccessDialogActiveAddresses() {
	const settings = await getSettings()
	return filterAccessDialogAddressesForChain(await getActiveAddresses(), settings.activeRpcNetwork.chainId)
}

async function withCurrentSignerState(pendingAccessRequest: PendingAccessRequest): Promise<PendingAccessRequest> {
	const tabState = await getTabState(pendingAccessRequest.socket.tabId)
	return {
		...pendingAccessRequest,
		signerAccounts: tabState.signerAccounts,
		signerName: tabState.signerName,
	}
}

async function withCurrentSignerStates(pendingAccessRequests: readonly PendingAccessRequest[]) {
	return await Promise.all(pendingAccessRequests.map(withCurrentSignerState))
}

export async function updateInterceptorAccessViewWithPendingRequests() {
	const pendingAccessRequests = await getPendingAccessRequests()
	if (pendingAccessRequests.length > 0) await sendPopupMessageToOpenWindows({ method: 'popup_interceptorAccessDialog', data: {
		activeAddresses: await getAccessDialogActiveAddresses(),
		pendingAccessRequests: await withCurrentSignerStates(pendingAccessRequests),
	} })
}

async function requestSignerAccountsFromSigner(
	websiteTabConnections: WebsiteTabConnections,
	socket: WebsiteSocket,
	requestAccounts: boolean,
	onlyIfUnavailable: boolean,
	options: SignerAccountRefreshOptions = {},
) {
	return await serializeSignerAccountRequest(websiteTabConnections, socket.tabId, async () => {
		const signerStateToken = await waitForConfirmedSignerStateToken(websiteTabConnections, socket.tabId)
		if (signerStateToken === undefined) return { accounts: [], error: signerUnavailableError }
		const tabState = await getTabState(socket.tabId)
		if (!isSignerStateTokenCurrent(websiteTabConnections, signerStateToken)) return { accounts: [], error: signerConnectionReplacedError }
		if (onlyIfUnavailable && tabState.signerAccounts.length !== 0) return { accounts: tabState.signerAccounts, error: undefined }

		const future = new Future<ErrorWithCodeAndOptionalData | undefined>
		const listener = createInternalMessageListener( (message: WindowMessage) => {
			if (message.method !== 'window_signer_accounts_changed') return
			if (websiteSocketToString(message.data.socket) !== websiteSocketToString(signerStateToken.socket)) return
			const currentSignerStateToken = getConfirmedSignerStateToken(websiteTabConnections, socket.tabId)
			const messageMatchesCurrentSignerState = currentSignerStateToken !== undefined
				&& currentSignerStateToken.port === signerStateToken.port
				&& message.data.signerStateOwnerGeneration === currentSignerStateToken.ownerGeneration
				&& message.data.signerProviderGeneration === currentSignerStateToken.signerProviderGeneration
			const messageSettlesInitialSignerState = message.data.signerStateOwnerGeneration === signerStateToken.ownerGeneration
				&& message.data.signerProviderGeneration === signerStateToken.signerProviderGeneration
				&& currentSignerStateToken?.port !== signerStateToken.port
			if (messageMatchesCurrentSignerState) return future.resolve(message.data.error)
			if (messageSettlesInitialSignerState) return future.resolve(message.data.error ?? signerConnectionReplacedError)
		})
		const channel = new BroadcastChannel(INTERNAL_CHANNEL_NAME)
		let error: ErrorWithCodeAndOptionalData | undefined
		try {
			channel.addEventListener('message', listener)
			const requestSignerAccountsMessage = requestAccounts
				? { type: 'result' as const, method: 'request_signer_to_eth_requestAccounts' as const, result: [] as const }
				: { type: 'result' as const, method: 'request_signer_to_eth_accounts' as const, result: [] as const }
			const messageSent = isSignerStateTokenCurrent(websiteTabConnections, signerStateToken)
				&& sendSubscriptionReplyOrCallBackToPort(signerStateToken.port, requestSignerAccountsMessage)
			if (messageSent) {
				error = requestAccounts
					? await future
					: await waitForSignerAccountReply(future, options.passiveReplyTimeoutMs ?? SIGNER_ACCOUNT_REPLY_TIMEOUT_MS)
			}
			else error = signerConnectionReplacedError
		} finally {
			channel.removeEventListener('message', listener)
			channel.close()
		}
		const completedSignerStateToken = getConfirmedSignerStateToken(websiteTabConnections, socket.tabId)
		if (completedSignerStateToken?.port !== signerStateToken.port) return { accounts: [], error: error ?? signerConnectionReplacedError }
		return { accounts: (await getTabState(socket.tabId)).signerAccounts, error }
	})
}

export async function askForSignerAccountsFromSignerIfNotAvailable(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, requestAccounts = true): Promise<SignerAccountsRequestResult> {
	return await requestSignerAccountsFromSigner(websiteTabConnections, socket, requestAccounts, true)
}

export async function refreshSignerAccountsFromApprovedWebsitePorts(websiteTabConnections: WebsiteTabConnections, requestAccounts: boolean) {
	const accountRequests: Promise<SignerAccountsRequestResult>[] = []
	for (const tabId of websiteTabConnections.keys()) {
		const signerStateToken = getConfirmedSignerStateToken(websiteTabConnections, tabId)
		if (signerStateToken === undefined || !tabHasApprovedWebsiteConnection(websiteTabConnections, tabId)) continue
		accountRequests.push(requestSignerAccountsFromSigner(websiteTabConnections, signerStateToken.socket, requestAccounts, false))
	}
	await Promise.all(accountRequests)
}

export async function refreshSignerAccountsForTab(
	websiteTabConnections: WebsiteTabConnections,
	tabId: number,
	requestAccounts: boolean,
	options: SignerAccountRefreshOptions = {},
) {
	const signerStateToken = getConfirmedSignerStateToken(websiteTabConnections, tabId)
	if (signerStateToken === undefined || !tabHasApprovedWebsiteConnection(websiteTabConnections, tabId)) return
	return await requestSignerAccountsFromSigner(websiteTabConnections, signerStateToken.socket, requestAccounts, false, options)
}

export async function requestAccessFromUser(
	websiteTabConnections: WebsiteTabConnections,
	socket: WebsiteSocket,
	website: Website,
	request: InterceptedRequest,
	requestAccessToAddress: AddressBookEntry | undefined,
	settings: Settings,
	activeAddressEntry: AddressBookEntry | undefined,
	replayInterceptedRequest: ReplayInterceptedRequest,
): Promise<void>
export async function requestAccessFromUser(
	websiteTabConnections: WebsiteTabConnections,
	socket: WebsiteSocket,
	website: Website,
	request: undefined,
	requestAccessToAddress: AddressBookEntry | undefined,
	settings: Settings,
	activeAddressEntry: AddressBookEntry | undefined,
	replayInterceptedRequest: undefined,
): Promise<void>
export async function requestAccessFromUser(
	websiteTabConnections: WebsiteTabConnections,
	socket: WebsiteSocket,
	website: Website,
	request: InterceptedRequest | undefined,
	requestAccessToAddress: AddressBookEntry | undefined,
	settings: Settings,
	activeAddressEntry: AddressBookEntry | undefined,
	replayInterceptedRequest: ReplayInterceptedRequest | undefined,
) {
	// check if we need to ask address access or not. If address is put to never need to have address specific permision, we don't need to ask for it
	const askForAddressAccess = requestAccessToAddress !== undefined && requestAccessToAddress.askForAddressAccess !== false
	const accessAddress = askForAddressAccess ? requestAccessToAddress : undefined
	const verifyAccessForCurrentRequest = (currentSettings: Settings) => {
		const verify = () => verifyAccess(
			websiteTabConnections,
			socket,
			true,
			website.websiteOrigin,
			activeAddressEntry,
			currentSettings,
			{ ignoreConnectionApproval: request !== undefined && isAccountConnectionMethod(request.method) },
		)
		if (request === undefined || !isAccountConnectionMethod(request.method)) return verify()
		return withSuppressedUnscopedConnectionEventsForSocket(request.uniqueRequestIdentifier.requestSocket, verify)
	}
	const closeWindowOrTabCallback = (popupOrTabId: PopupOrTabId) => onCloseWindowOrTab(popupOrTabId, websiteTabConnections)
	const onCloseWindowCallback = async (id: number) => closeWindowOrTabCallback({ type: 'popup' as const, id })
	const onCloseTabCallback = async (id: number) => closeWindowOrTabCallback({ type: 'tab' as const, id })
	const pendingReplay = await pendingInterceptorAccessSemaphore.execute(async () => {
		const verifyPendingRequests = async () => {
			const previousRequests = await getPendingAccessRequests()
			if (previousRequests.length !== 0) {
				const previousRequest = previousRequests[0]
				if (previousRequest === undefined) throw new Error('missing previous request')
				const existingPopupOrTab = await getPopupOrTabById(previousRequest.popupOrTabId)
				if (existingPopupOrTab !== undefined) {
					if (openedDialog === undefined) {
						addWindowTabListeners(onCloseWindowCallback, onCloseTabCallback)
						openedDialog = { popupOrTab: existingPopupOrTab, onClosePopup: onCloseWindowCallback, onCloseTab: onCloseTabCallback }
					}
					return previousRequests
				}
				await clearPendingAccessRequests()
			}
			return []
		}

		const previousPendingRequests = await verifyPendingRequests()
		const justAddToPending = previousPendingRequests.length !== 0
		const hasAccess = verifyAccessForCurrentRequest(await getSettings())
		// Access was granted or denied after the router decided to ask. No dialog is needed: replay the request so the router answers it from the current settings.
		if (hasAccess !== 'askAccess') {
			if (request === undefined) return undefined
			if (replayInterceptedRequest === undefined) throw new Error('A replay callback is required to replay an intercepted request.')
			return { website, socket, request }
		}
		const replayedPendingRequest = request === undefined ? undefined : previousPendingRequests.find((pendingRequest) => {
			return pendingRequest.request !== undefined && doesUniqueRequestIdentifiersMatch(pendingRequest.request.uniqueRequestIdentifier, request.uniqueRequestIdentifier)
		})
		if (replayedPendingRequest !== undefined) {
			if (openedDialog !== undefined) await tryFocusingTabOrWindow(openedDialog.popupOrTab)
			return undefined
		}
		if (!justAddToPending) {
			addWindowTabListeners(onCloseWindowCallback, onCloseTabCallback)
			const popupOrTab = await openPopupOrTab({
				url: getHtmlFile('interceptorAccess'),
				type: 'popup',
				height: 800,
				width: 600,
			})
			if (popupOrTab === undefined) {
				if (request !== undefined) refuseAccess(websiteTabConnections, request)
				throw new Error('Opened dialog does not exist when expected in requestAccessFromUser function')
			}
			if (openedDialog) {
				removeWindowTabListeners(openedDialog.onClosePopup, openedDialog.onCloseTab)
				await closePopupOrTabById(openedDialog.popupOrTab)
			}
			openedDialog = { popupOrTab, onClosePopup: onCloseWindowCallback, onCloseTab: onCloseTabCallback,  }
		}

		if (openedDialog === undefined) {
			if (request !== undefined) refuseAccess(websiteTabConnections, request)
			throw new Error('Opened dialog does not exist when expected in requestAccessFromUser function')
		}
		const accessRequestId =  `${ accessAddress?.address } || ${ website.websiteOrigin }`
		const tabState = await getTabState(socket.tabId)
		const pendingRequest = {
			popupOrTabId: openedDialog.popupOrTab,
			socket,
			request,
			accessRequestId,
			website,
			requestAccessToAddress: accessAddress,
			originalRequestAccessToAddress: accessAddress,
			associatedAddresses: requestAccessToAddress !== undefined ? await getAssociatedAddresses(settings, website.websiteOrigin, requestAccessToAddress) : [],
			signerAccounts: tabState.signerAccounts,
			signerName: tabState.signerName,
			simulationMode: settings.simulationMode,
			activeAddress: activeAddressEntry?.address,
		}

		const pendingRequests = await updatePendingAccessRequests(async (previousPendingAccessRequests) => {
			// check that it doesn't have access already
			if (verifyAccessForCurrentRequest(await getSettings()) !== 'askAccess') return previousPendingAccessRequests

			// check that we are not tracking it already
			if (previousPendingAccessRequests.find((x) => x.accessRequestId === accessRequestId) === undefined) {
				return previousPendingAccessRequests.concat(pendingRequest)
			}
			return previousPendingAccessRequests
		})
		const oldPendingRequest = pendingRequests.previous.find((x) => x.accessRequestId === accessRequestId)
		if (oldPendingRequest !== undefined) {
			if (openedDialog !== undefined) await tryFocusingTabOrWindow(openedDialog.popupOrTab)
			if (request !== undefined) {
				replyToInterceptedRequest(websiteTabConnections, {
					type: 'result',
					uniqueRequestIdentifier: request.uniqueRequestIdentifier,
					method: request.method,
					error: METAMASK_ERROR_ALREADY_PENDING.error,
				})
			}
			return undefined
		}
		if (pendingRequests.current.findIndex((x) => x.accessRequestId === accessRequestId) === 0) {
			await sendPopupMessageToOpenWindows({ method: 'popup_interceptorAccessDialog', data: {
				activeAddresses: await getAccessDialogActiveAddresses(),
				pendingAccessRequests: await withCurrentSignerStates(pendingRequests.current),
			} })
		}
		await sendPopupMessageToOpenWindows({
			method: 'popup_interceptor_access_dialog_pending_changed',
			data: {
				activeAddresses: await getAccessDialogActiveAddresses(),
				pendingAccessRequests: await withCurrentSignerStates(pendingRequests.current),
			}
		})
		if (openedDialog !== undefined) await tryFocusingTabOrWindow(openedDialog.popupOrTab)
		return undefined
	})
	if (pendingReplay === undefined) return
	if (replayInterceptedRequest === undefined) throw new Error('A replay callback is required to replay an intercepted request.')
	await replayInterceptedRequest(pendingReplay)
}

async function resolve(websiteTabConnections: WebsiteTabConnections, accessReply: InterceptorAccessReply, pendingAccessRequest: PendingAccessRequest, applyAccessReply: ApplyInterceptorAccessReply) {
	const { request, website } = pendingAccessRequest
	let promptForFollowUpAccesses = false
	if (accessReply.userReply === 'noResponse') {
		if (request !== undefined) refuseAccess(websiteTabConnections, request)
	} else {
		const requestedEntry = pendingAccessRequest.requestAccessToAddress
		const originalEntry = pendingAccessRequest.originalRequestAccessToAddress
		const pendingEntryChanged = requestedEntry === undefined || originalEntry === undefined
			? requestedEntry !== originalEntry
			: requestedEntry.address !== originalEntry.address
				|| requestedEntry.type !== originalEntry.type
				|| !doAddressBookChainIdsMatch(requestedEntry.chainId, originalEntry.chainId)
		const userRequestedAddressChange = accessReply.requestAccessToAddress !== accessReply.originalRequestAccessToAddress || pendingEntryChanged
		const replyCompletesAccountRequest = request !== undefined && isAccountConnectionMethod(request.method)
		promptForFollowUpAccesses = !replyCompletesAccountRequest
		const accountRequestSocket = replyCompletesAccountRequest ? request.uniqueRequestIdentifier.requestSocket : undefined
		const applyReply = async () => await applyAccessReply(accessReply, pendingAccessRequest, userRequestedAddressChange)
		if (accountRequestSocket === undefined) {
			await applyReply()
		} else {
			await withSuppressedUnscopedConnectionEventsForSocketAsync(accountRequestSocket, applyReply)
		}
	}

	const isAffectedEntry = (pending: PendingAccessRequest) => pending.website.websiteOrigin === website.websiteOrigin && (pending.requestAccessToAddress?.address === accessReply.requestAccessToAddress || pending.requestAccessToAddress?.address === accessReply.originalRequestAccessToAddress)

	const pendingRequests = await updatePendingAccessRequests(async (previousPendingAccessRequests) => previousPendingAccessRequests.filter((pending) => !isAffectedEntry(pending)))

	if (pendingRequests.current.length > 0) {
		sendPopupMessageToOpenWindows({ method: 'popup_interceptorAccessDialog', data: { activeAddresses: await getAccessDialogActiveAddresses(), pendingAccessRequests: await withCurrentSignerStates(pendingRequests.current) } })
		return { pendingRequestsToReplay: [], promptForFollowUpAccesses }
	}

	if (openedDialog) {
		removeWindowTabListeners(openedDialog.onClosePopup, openedDialog.onCloseTab)
		await closePopupOrTabById(openedDialog.popupOrTab)
		openedDialog = undefined
	}
	const pendingRequestsToReplay = pendingRequests.previous.filter((pending): pending is PendingAccessRequest & { request: InterceptedRequest } => isAffectedEntry(pending) && pending.request !== undefined)
	return { pendingRequestsToReplay, promptForFollowUpAccesses }
}

export async function requestAddressChange(websiteTabConnections: WebsiteTabConnections, message: InterceptorAccessChangeAddress | InterceptorAccessRefresh) {
	const newRequests = await updatePendingAccessRequests(async (previousPendingAccessRequests) => {
		if (message.data.requestAccessToAddress === undefined) throw new Error('Requesting account change on site level access request')
		const pendingAccessRequest = previousPendingAccessRequests.find((request) => request.accessRequestId === message.data.accessRequestId)
		if (pendingAccessRequest === undefined) throw new Error('Access request missing!')
		const explicitlyRequestedSelection = message.method === 'popup_interceptorAccessChangeAddress'
			? await getAllowedAddressSelectionForAccessRequest(pendingAccessRequest, message.data.newActiveAddress, 'explicitSelection')
			: undefined
		async function getProposedSelection() {
			if (message.method === 'popup_interceptorAccessRefresh') {
				const tabState = await getTabState(message.data.socket.tabId)
				const signerAddress = tabState.signerAccounts[0]
				return signerAddress === undefined ? undefined : { type: 'signer', address: signerAddress } as const
			}
			if (explicitlyRequestedSelection?.type === 'signer' && explicitlyRequestedSelection.address === undefined) {
				const signerAccountsResult = await askForSignerAccountsFromSignerIfNotAvailable(websiteTabConnections, message.data.socket)
				const signerAddress = signerAccountsResult.accounts[0]
				return signerAddress === undefined ? undefined : { type: 'signer', address: signerAddress } as const
			}
			return explicitlyRequestedSelection
		}

		const proposedSelection = await getProposedSelection()
		const settings = await getSettings()
		const requestAccessToAddress = proposedSelection === undefined
			? pendingAccessRequest.requestAccessToAddress
			: proposedSelection.type === 'addressBookEntry' && proposedSelection.entry.type === 'safe'
				? proposedSelection.entry
				: proposedSelection.type === 'addressBookEntry'
					? await getActiveAddressEntryForChain(proposedSelection.entry.address, settings.activeRpcNetwork.chainId)
					: proposedSelection.address === undefined
					? pendingAccessRequest.requestAccessToAddress
					: await getWalletActiveAddressEntryForChain(proposedSelection.address, settings.activeRpcNetwork.chainId)
		if (requestAccessToAddress === undefined) throw new Error('Access request has no address to refresh')
		const associatedAddresses = await getAssociatedAddresses(settings, message.data.website.websiteOrigin, requestAccessToAddress)
		return previousPendingAccessRequests.map((request) => {
			if (request.accessRequestId === message.data.accessRequestId) return { ...request, associatedAddresses, requestAccessToAddress }
			return request
		})
	})
	return await sendPopupMessageToOpenWindows({ method: 'popup_interceptorAccessDialog', data: { activeAddresses: await getAccessDialogActiveAddresses(), pendingAccessRequests: await withCurrentSignerStates(newRequests.current) } })
}

export async function getAllowedAddressSelectionForAccessRequest(pendingAccessRequest: PendingAccessRequest, address: bigint | 'signer', selectionSource: 'explicitSelection' | 'pendingEntry') {
	const settings = await getSettings()
	const simulationMode = pendingAccessRequest.simulationMode && settings.simulationMode
	const signerAccounts = (await getTabState(pendingAccessRequest.socket.tabId)).signerAccounts
	const activeAddresses = await getActiveAddresses()
	const requestedEntry = pendingAccessRequest.requestAccessToAddress
	const selectableAddresses = selectionSource === 'pendingEntry'
		? includePersistedAddressBookEntry(activeAddresses, requestedEntry)
		: activeAddresses
	// Access replies carry the approved address, while the pending entry preserves whether a same-address signing selection was explicitly a Safe.
	const addressSelection = selectionSource === 'pendingEntry'
		&& !simulationMode
		&& address !== 'signer'
		&& address === signerAccounts[0]
		&& (requestedEntry?.address !== address || requestedEntry.type !== 'safe')
		? 'signer'
		: address
	return assertActiveAddressSelectionAllowed(addressSelection, selectableAddresses, simulationMode, settings.activeRpcNetwork.chainId, signerAccounts)
}

export async function interceptorAccessMetadataRefresh() {
	const settings = await getSettings()
	await sendPopupMessageToOpenWindows({
		method: 'popup_interceptorAccessDialog',
		data: {
			activeAddresses: await getAccessDialogActiveAddresses(),
			pendingAccessRequests: await Promise.all((await getPendingAccessRequests()).map(async (request) => {
				const requestAccessToAddress = request.requestAccessToAddress === undefined ? undefined : request.requestAccessToAddress
				const tabState = await getTabState(request.socket.tabId)
				const associatedAddresses = await getAssociatedAddresses(settings, request.website.websiteOrigin, requestAccessToAddress)
				return {
					...request,
					signerAccounts: tabState.signerAccounts,
					signerName: tabState.signerName,
					associatedAddresses,
					requestAccessToAddress
				}
			}))
		}
	})
}
