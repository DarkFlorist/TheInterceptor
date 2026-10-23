import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { generateUuidV4 } from '../utils/uuid.js'
import type { InterceptedRequestForward } from '../types/interceptor-messages.js'
import { METAMASK_ERROR_NOT_AUTHORIZED } from '../utils/constants.js'
import { isTopFrameId, websiteSocketToString, type WebsiteSocket } from '../utils/requests.js'

type GateReservation = {
	readonly release: () => void
}

type ActiveSignerSelectionLease = {
	readonly tabId: number
	readonly socket?: WebsiteSocket
	readonly release: () => void
	readonly timeout: ReturnType<typeof setTimeout>
}

type SignerExecutionAuthority = {
	readonly websiteOrigin: string
	readonly documentGeneration: string
	readonly mode: 'pending' | 'blocked' | 'legacy' | 'eip6963'
	readonly providerUuid: string | undefined
	readonly eligibleSocketKeys: Set<string>
	readonly authorizedSocketKeys: Set<string>
}

type SignerCoordinationState = {
	readonly gateTailsByTab: Map<number, Promise<void>>
	readonly activeLeasesByToken: Map<string, ActiveSignerSelectionLease>
	readonly authoritativeTopSocketKeys: Map<number, string>
	readonly signerExecutionAuthorities: Map<number, SignerExecutionAuthority>
	readonly currentChildSocketKeysByTab: Map<number, Map<number, string>>
	readonly childFrameIdsBySocketKey: Map<string, number>
	readonly pendingChildSocketRemovalTimers: Map<string, ReturnType<typeof setTimeout>>
}

// One collection-scoped owner holds document authority and selection reservations privately, so copying connection/UI snapshots cannot grant execution. TabState is persisted display data; signerStateOwner tracks callback freshness rather than execution permission.
const signerCoordinationByConnections = new WeakMap<WebsiteTabConnections, SignerCoordinationState>()

// Registration and workflow reservations initialize this collection's ephemeral state; queries never attach state. Persisted TabState is a UI/catalog snapshot and never grants execution authority.
function createSignerCoordinationState(): SignerCoordinationState {
	return {
		gateTailsByTab: new Map(),
		activeLeasesByToken: new Map(),
		authoritativeTopSocketKeys: new Map<number, string>(),
		signerExecutionAuthorities: new Map<number, SignerExecutionAuthority>(),
		currentChildSocketKeysByTab: new Map<number, Map<number, string>>(),
		childFrameIdsBySocketKey: new Map<string, number>(),
		pendingChildSocketRemovalTimers: new Map<string, ReturnType<typeof setTimeout>>(),
	}
}

function initializeSignerCoordination(websiteTabConnections: WebsiteTabConnections) {
	const current = signerCoordinationByConnections.get(websiteTabConnections)
	if (current !== undefined) return current
	const state = createSignerCoordinationState()
	signerCoordinationByConnections.set(websiteTabConnections, state)
	return state
}

export function registerCurrentChildSignerSocket(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, frameId: number) {
	if (isTopFrameId(frameId)) return false
	releaseSignerSelectionLeasesForSocket(websiteTabConnections, socket)
	const { signerExecutionAuthorities, currentChildSocketKeysByTab, childFrameIdsBySocketKey, pendingChildSocketRemovalTimers } = initializeSignerCoordination(websiteTabConnections)
	const key = websiteSocketToString(socket)
	const pendingRemoval = pendingChildSocketRemovalTimers.get(key)
	if (pendingRemoval !== undefined) {
		clearTimeout(pendingRemoval)
		pendingChildSocketRemovalTimers.delete(key)
	}
	const currentForTab = currentChildSocketKeysByTab.get(socket.tabId) ?? new Map<number, string>()
	currentChildSocketKeysByTab.set(socket.tabId, currentForTab)
	const previousKey = currentForTab.get(frameId)
	if (previousKey === key) return false
	currentForTab.set(frameId, key)
	childFrameIdsBySocketKey.set(key, frameId)
	const authority = signerExecutionAuthorities.get(socket.tabId)
	if (previousKey !== undefined) {
		for (const lease of signerCoordinationByConnections.get(websiteTabConnections)?.activeLeasesByToken.values() ?? []) {
			if (lease.socket !== undefined && websiteSocketToString(lease.socket) === previousKey) lease.release()
		}
		childFrameIdsBySocketKey.delete(previousKey)
		authority?.eligibleSocketKeys.delete(previousKey)
		authority?.authorizedSocketKeys.delete(previousKey)
	}
	return true
}

export function unregisterCurrentChildSignerSocket(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket) {
	releaseSignerSelectionLeasesForSocket(websiteTabConnections, socket)
	const state = signerCoordinationByConnections.get(websiteTabConnections)
	if (state === undefined) return false
	const { signerExecutionAuthorities, currentChildSocketKeysByTab, childFrameIdsBySocketKey, pendingChildSocketRemovalTimers } = state
	const key = websiteSocketToString(socket)
	const pendingRemoval = pendingChildSocketRemovalTimers.get(key)
	if (pendingRemoval !== undefined) clearTimeout(pendingRemoval)
	pendingChildSocketRemovalTimers.delete(key)
	const frameId = childFrameIdsBySocketKey.get(key)
	childFrameIdsBySocketKey.delete(key)
	if (frameId === undefined) return false
	const currentForTab = currentChildSocketKeysByTab.get(socket.tabId)
	if (currentForTab?.get(frameId) !== key) return false
	currentForTab.delete(frameId)
	if (currentForTab.size === 0) currentChildSocketKeysByTab.delete(socket.tabId)
	const authority = signerExecutionAuthorities.get(socket.tabId)
	authority?.eligibleSocketKeys.delete(key)
	authority?.authorizedSocketKeys.delete(key)
	return true
}

export function scheduleCurrentChildSignerSocketRemoval(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket) {
	const state = signerCoordinationByConnections.get(websiteTabConnections)
	if (state === undefined) return false
	const { childFrameIdsBySocketKey, pendingChildSocketRemovalTimers } = state
	const key = websiteSocketToString(socket)
	if (!childFrameIdsBySocketKey.has(key) || pendingChildSocketRemovalTimers.has(key)) return false
	const timeout = setTimeout(() => {
		pendingChildSocketRemovalTimers.delete(key)
		unregisterCurrentChildSignerSocket(websiteTabConnections, socket)
	}, 1000)
	pendingChildSocketRemovalTimers.set(key, timeout)
	return true
}

export function registerAuthoritativeTopSocket(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, websiteOrigin: string) {
	const { authoritativeTopSocketKeys, signerExecutionAuthorities } = initializeSignerCoordination(websiteTabConnections)
	const key = websiteSocketToString(socket)
	const current = signerExecutionAuthorities.get(socket.tabId)
	if (authoritativeTopSocketKeys.get(socket.tabId) === key && current?.websiteOrigin === websiteOrigin) {
		return false
	}
	releaseSignerSelectionLeasesForTab(websiteTabConnections, socket.tabId)
	authoritativeTopSocketKeys.set(socket.tabId, key)
	// Every document starts blocked until its initial (possibly empty) EIP-6963 catalog has been reconciled with the site's stored preference.
	signerExecutionAuthorities.set(socket.tabId, {
		websiteOrigin,
		documentGeneration: generateUuidV4(),
		mode: 'pending',
		providerUuid: undefined,
		eligibleSocketKeys: new Set(),
		authorizedSocketKeys: new Set(),
	})
	return true
}

export function getSignerDocumentGenerationForOrigin(websiteTabConnections: WebsiteTabConnections, tabId: number, websiteOrigin: string) {
	const state = signerCoordinationByConnections.get(websiteTabConnections)
	if (state === undefined) return undefined
	const { signerExecutionAuthorities } = state
	const authority = signerExecutionAuthorities.get(tabId)
	return authority?.websiteOrigin === websiteOrigin ? authority.documentGeneration : undefined
}

export function getSignerDocumentGeneration(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, websiteOrigin: string) {
	return isAuthoritativeTopSocket(websiteTabConnections, socket) ? getSignerDocumentGenerationForOrigin(websiteTabConnections, socket.tabId, websiteOrigin) : undefined
}

export function isCurrentChildSignerSocket(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, frameId: number | undefined) {
	const state = signerCoordinationByConnections.get(websiteTabConnections)
	if (state === undefined) return false
	const { currentChildSocketKeysByTab } = state
	return frameId !== undefined && !isTopFrameId(frameId) && currentChildSocketKeysByTab.get(socket.tabId)?.get(frameId) === websiteSocketToString(socket)
}

export function reconcileSignerExecutionDocument(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, websiteOrigin: string, documentGeneration: string | undefined, isTopFrame: boolean, frameId: number | undefined) {
	const state = signerCoordinationByConnections.get(websiteTabConnections)
	if (state === undefined) return false
	const { signerExecutionAuthorities } = state
	const authority = signerExecutionAuthorities.get(socket.tabId)
	const key = websiteSocketToString(socket)
	if (authority === undefined || authority.websiteOrigin !== websiteOrigin) return false
	if (isTopFrame) {
		if (!isAuthoritativeTopSocket(websiteTabConnections, socket)) return false
		authority.eligibleSocketKeys.add(key)
		return true
	}
	if (!isCurrentChildSignerSocket(websiteTabConnections, socket, frameId)) return false
	if (authority.documentGeneration !== documentGeneration) return false
	authority.eligibleSocketKeys.add(key)
	return true
}

export function isAuthoritativeTopSocket(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket) {
	const state = signerCoordinationByConnections.get(websiteTabConnections)
	if (state === undefined) return false
	const { authoritativeTopSocketKeys } = state
	return authoritativeTopSocketKeys.get(socket.tabId) === websiteSocketToString(socket)
}

export function setSignerExecutionTarget(websiteTabConnections: WebsiteTabConnections, tabId: number, providerUuid: string, websiteOrigin: string) {
	const state = signerCoordinationByConnections.get(websiteTabConnections)
	if (state === undefined) return false
	const { authoritativeTopSocketKeys, signerExecutionAuthorities } = state
	const current = signerExecutionAuthorities.get(tabId)
	if (current === undefined || current.websiteOrigin !== websiteOrigin || !current.eligibleSocketKeys.has(authoritativeTopSocketKeys.get(tabId) ?? '')) return false
	if (current.mode === 'eip6963' && current.providerUuid === providerUuid) return true
	signerExecutionAuthorities.set(tabId, {
		websiteOrigin,
		documentGeneration: current.documentGeneration,
		mode: 'eip6963',
		providerUuid,
		eligibleSocketKeys: current.eligibleSocketKeys,
		authorizedSocketKeys: new Set(),
	})
	return true
}

export function allowLegacySignerExecution(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, websiteOrigin: string) {
	const state = signerCoordinationByConnections.get(websiteTabConnections)
	if (state === undefined) return false
	const { signerExecutionAuthorities } = state
	if (!isAuthoritativeTopSocket(websiteTabConnections, socket)) return false
	const current = signerExecutionAuthorities.get(socket.tabId)
	if (current === undefined || current.websiteOrigin !== websiteOrigin || !current.eligibleSocketKeys.has(websiteSocketToString(socket))) return false
	if (current.mode === 'legacy') {
		current.authorizedSocketKeys.add(websiteSocketToString(socket))
		return true
	}
	signerExecutionAuthorities.set(socket.tabId, {
		websiteOrigin,
		documentGeneration: current.documentGeneration,
		mode: 'legacy',
		providerUuid: undefined,
		eligibleSocketKeys: current.eligibleSocketKeys,
		authorizedSocketKeys: new Set([websiteSocketToString(socket)]),
	})
	return true
}

export function blockSignerExecution(websiteTabConnections: WebsiteTabConnections, tabId: number) {
	const state = signerCoordinationByConnections.get(websiteTabConnections)
	if (state === undefined) return
	const { signerExecutionAuthorities } = state
	const current = signerExecutionAuthorities.get(tabId)
	if (current === undefined) return
	signerExecutionAuthorities.set(tabId, {
		websiteOrigin: current.websiteOrigin,
		documentGeneration: current.documentGeneration,
		mode: 'blocked',
		providerUuid: undefined,
		eligibleSocketKeys: current.eligibleSocketKeys,
		authorizedSocketKeys: new Set(),
	})
}

export function signerSelectionIsUnavailable(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, websiteOrigin: string) {
	const state = signerCoordinationByConnections.get(websiteTabConnections)
	if (state === undefined) return false
	const { signerExecutionAuthorities } = state
	const authority = signerExecutionAuthorities.get(socket.tabId)
	return authority?.mode === 'blocked' && authority.websiteOrigin === websiteOrigin
}

export function getSignerExecutionTargetForOrigin(websiteTabConnections: WebsiteTabConnections, tabId: number, websiteOrigin: string) {
	const state = signerCoordinationByConnections.get(websiteTabConnections)
	if (state === undefined) return undefined
	const { signerExecutionAuthorities } = state
	const authority = signerExecutionAuthorities.get(tabId)
	if (authority?.mode !== 'eip6963' || authority.websiteOrigin !== websiteOrigin) return undefined
	return authority.providerUuid
}

export function getSignerExecutionTargetForSocket(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, websiteOrigin: string) {
	const state = signerCoordinationByConnections.get(websiteTabConnections)
	if (state === undefined) return undefined
	const { signerExecutionAuthorities } = state
	const authority = signerExecutionAuthorities.get(socket.tabId)
	if (authority?.mode !== 'eip6963'
		|| authority.websiteOrigin !== websiteOrigin
		|| !authority.eligibleSocketKeys.has(websiteSocketToString(socket))) return undefined
	return authority.providerUuid
}

export function signerFrameHasDifferentOrigin(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, websiteOrigin: string) {
	const state = signerCoordinationByConnections.get(websiteTabConnections)
	if (state === undefined) return false
	const { signerExecutionAuthorities } = state
	const authority = signerExecutionAuthorities.get(socket.tabId)
	return authority !== undefined && authority.websiteOrigin !== websiteOrigin
}

export function socketIsEligibleForSignerExecution(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, websiteOrigin: string) {
	const state = signerCoordinationByConnections.get(websiteTabConnections)
	if (state === undefined) return false
	const { signerExecutionAuthorities } = state
	const authority = signerExecutionAuthorities.get(socket.tabId)
	return authority?.websiteOrigin === websiteOrigin && authority.eligibleSocketKeys.has(websiteSocketToString(socket))
}

export function authorizeSocketForSignerExecution(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, providerUuid: string, websiteOrigin: string) {
	const state = signerCoordinationByConnections.get(websiteTabConnections)
	if (state === undefined) return false
	const { signerExecutionAuthorities } = state
	const authority = signerExecutionAuthorities.get(socket.tabId)
	const key = websiteSocketToString(socket)
	if (authority?.mode !== 'eip6963'
		|| authority.providerUuid !== providerUuid
		|| authority.websiteOrigin !== websiteOrigin
		|| !authority.eligibleSocketKeys.has(key)) return false
	authority.authorizedSocketKeys.add(key)
	return true
}

export function authorizeSocketForLegacySignerExecution(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, websiteOrigin: string) {
	const state = signerCoordinationByConnections.get(websiteTabConnections)
	if (state === undefined) return false
	const { signerExecutionAuthorities } = state
	const authority = signerExecutionAuthorities.get(socket.tabId)
	const key = websiteSocketToString(socket)
	if (authority?.mode !== 'legacy'
		|| authority.websiteOrigin !== websiteOrigin
		|| !authority.eligibleSocketKeys.has(key)) return false
	authority.authorizedSocketKeys.add(key)
	return true
}

export function socketCanExecuteWithSelectedSigner(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket) {
	const state = signerCoordinationByConnections.get(websiteTabConnections)
	if (state === undefined) return false
	const { signerExecutionAuthorities, currentChildSocketKeysByTab, childFrameIdsBySocketKey } = state
	const key = websiteSocketToString(socket)
	const authority = signerExecutionAuthorities.get(socket.tabId)
	if (authority?.authorizedSocketKeys.has(key) !== true) return false
	if (isAuthoritativeTopSocket(websiteTabConnections, socket)) return true
	const frameId = childFrameIdsBySocketKey.get(key)
	return frameId !== undefined && currentChildSocketKeysByTab.get(socket.tabId)?.get(frameId) === key
}

export function clearSignerExecutionAuthorityForTab(websiteTabConnections: WebsiteTabConnections, tabId: number) {
	releaseSignerSelectionLeasesForTab(websiteTabConnections, tabId)
	const state = signerCoordinationByConnections.get(websiteTabConnections)
	if (state === undefined) return
	const { authoritativeTopSocketKeys, signerExecutionAuthorities, currentChildSocketKeysByTab, childFrameIdsBySocketKey, pendingChildSocketRemovalTimers } = state
	authoritativeTopSocketKeys.delete(tabId)
	signerExecutionAuthorities.delete(tabId)
	currentChildSocketKeysByTab.delete(tabId)
	for (const [key] of childFrameIdsBySocketKey) {
		if (key.startsWith(`${ tabId }-`)) childFrameIdsBySocketKey.delete(key)
	}
	for (const [key, timeout] of pendingChildSocketRemovalTimers) {
		if (!key.startsWith(`${ tabId }-`)) continue
		clearTimeout(timeout)
		pendingChildSocketRemovalTimers.delete(key)
	}
	// The last document's cleanup releases the collection's authority state. Read-only policy checks never recreate it.
	if (authoritativeTopSocketKeys.size === 0 && signerExecutionAuthorities.size === 0 && currentChildSocketKeysByTab.size === 0
		&& childFrameIdsBySocketKey.size === 0 && pendingChildSocketRemovalTimers.size === 0 && state.gateTailsByTab.size === 0 && state.activeLeasesByToken.size === 0) signerCoordinationByConnections.delete(websiteTabConnections)
}

export function getSignerExecutionError(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket) {
	if (socketCanExecuteWithSelectedSigner(websiteTabConnections, socket)) return undefined
	return { code: METAMASK_ERROR_NOT_AUTHORIZED, message: 'The selected signer provider is not ready for this frame. Retry the request after wallet synchronization completes.' }
}

export function authorizeSignerForward(websiteTabConnections: WebsiteTabConnections, message: InterceptedRequestForward): InterceptedRequestForward {
	if (message.type !== 'forwardToSigner') return message
	const error = getSignerExecutionError(websiteTabConnections, message.uniqueRequestIdentifier.requestSocket)
	return error === undefined ? message : { ...message, type: 'result', error }
}

async function reserveSignerSelectionGate(websiteTabConnections: WebsiteTabConnections, tabId: number): Promise<GateReservation> {
	const { gateTailsByTab } = initializeSignerCoordination(websiteTabConnections)
	const previousTail = gateTailsByTab.get(tabId) ?? Promise.resolve()
	let releaseReservation: (() => void) | undefined
	const completion = new Promise<void>((resolve) => { releaseReservation = resolve })
	const currentTail = previousTail.then(async () => await completion)
	gateTailsByTab.set(tabId, currentTail)
	await previousTail
	let released = false
	const release = () => {
		if (released) return
		released = true
		releaseReservation?.()
		void currentTail.then(() => {
			if (gateTailsByTab.get(tabId) === currentTail) gateTailsByTab.delete(tabId)
		})
	}
	return { release }
}

export async function acquireSignerSelectionLease(websiteTabConnections: WebsiteTabConnections, tabId: number, socket?: WebsiteSocket) {
	const { activeLeasesByToken } = initializeSignerCoordination(websiteTabConnections)
	const reservation = await reserveSignerSelectionGate(websiteTabConnections, tabId)
	const token = crypto.randomUUID()
	const release = () => {
		const lease = activeLeasesByToken.get(token)
		if (lease === undefined) return
		activeLeasesByToken.delete(token)
		clearTimeout(lease.timeout)
		reservation.release()
	}
	const timeout = setTimeout(release, 30_000)
	activeLeasesByToken.set(token, { tabId, socket, release, timeout })
	return token
}

export function releaseSignerSelectionLease(websiteTabConnections: WebsiteTabConnections, tabId: number, token: string) {
	const lease = signerCoordinationByConnections.get(websiteTabConnections)?.activeLeasesByToken.get(token)
	if (lease?.tabId !== tabId) return false
	lease.release()
	return true
}

export function signerSelectionLeaseIsActive(websiteTabConnections: WebsiteTabConnections, tabId: number, token: string) {
	return signerCoordinationByConnections.get(websiteTabConnections)?.activeLeasesByToken.get(token)?.tabId === tabId
}

function releaseSignerSelectionLeasesForTab(websiteTabConnections: WebsiteTabConnections, tabId: number) {
	for (const lease of signerCoordinationByConnections.get(websiteTabConnections)?.activeLeasesByToken.values() ?? []) {
		if (lease.tabId === tabId) lease.release()
	}
}

export function releaseSignerSelectionLeasesForSocket(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket) {
	for (const lease of signerCoordinationByConnections.get(websiteTabConnections)?.activeLeasesByToken.values() ?? []) {
		if (lease.socket?.tabId === socket.tabId && lease.socket.connectionName === socket.connectionName) lease.release()
	}
}

export async function runWithSignerSelectionGate<T>(websiteTabConnections: WebsiteTabConnections, tabId: number, action: () => Promise<T>) {
	const reservation = await reserveSignerSelectionGate(websiteTabConnections, tabId)
	try {
		return await action()
	} finally {
		reservation.release()
	}
}
