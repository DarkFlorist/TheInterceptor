import { createChildSignerSockets } from './childSignerSockets.js'
import { createSignerSelectionLeaseGate } from './signerSelectionLeaseGate.js'
import type { SignerExecutionOwner, WebsiteTabConnections } from '../types/user-interface-types.js'
import { generateUuidV4 } from '../utils/uuid.js'
import type { InterceptedRequestForward } from '../types/interceptor-messages.js'
import { METAMASK_ERROR_NOT_AUTHORIZED } from '../utils/constants.js'
import { isTopFrameId, websiteSocketToString, type WebsiteSocket } from '../utils/requests.js'

type SignerExecutionAuthority = {
	readonly websiteOrigin: string
	readonly documentGeneration: string
	readonly mode: 'pending' | 'blocked' | 'legacy' | 'eip6963'
	readonly providerUuid: string | undefined
	readonly eligibleSocketKeys: Set<string>
	readonly authorizedSocketKeys: Set<string>
}

type SignerCoordinationState = {
	readonly selectionGate: ReturnType<typeof createSignerSelectionLeaseGate>
	readonly childSockets: ReturnType<typeof createChildSignerSockets>
	readonly authoritativeTopSocketKeys: Map<number, string>
	readonly signerExecutionAuthorities: Map<number, SignerExecutionAuthority>
}

// The tab record owns this capability across connection-collection reconstruction. Its callbacks control lifetime; private proofs cannot be manufactured by copying plain state fields. TabState remains a persisted UI snapshot.
const signerCoordinationByOwner = new WeakMap<SignerExecutionOwner, SignerCoordinationState>()

// Resolve the current tab capability at each admission boundary; permission APIs accept this opaque handle, not a connection collection or persisted snapshot.
export function getSignerExecutionOwner(websiteTabConnections: WebsiteTabConnections, tabId: number) {
	return websiteTabConnections.get(tabId)?.signerExecutionOwner
}

function getSignerCoordination(owner: SignerExecutionOwner | undefined) {
	return owner === undefined ? undefined : signerCoordinationByOwner.get(owner)
}

// Registration and workflow reservations initialize this collection's ephemeral state; queries never attach state. Persisted TabState is a UI/catalog snapshot and never grants execution authority.
function createSignerCoordinationState(): SignerCoordinationState {
	const signerExecutionAuthorities = new Map<number, SignerExecutionAuthority>()
	const selectionGate = createSignerSelectionLeaseGate()
	const invalidateSocket = (key: string, tabId: number) => {
		selectionGate.releaseForSocketKey(key)
		const authority = signerExecutionAuthorities.get(tabId)
		authority?.eligibleSocketKeys.delete(key)
		authority?.authorizedSocketKeys.delete(key)
	}
	return {
		authoritativeTopSocketKeys: new Map<number, string>(),
		signerExecutionAuthorities,
		selectionGate,
		childSockets: createChildSignerSockets(invalidateSocket, selectionGate.releaseForSocketKey),
	}
}

function initializeSignerCoordination(websiteTabConnections: WebsiteTabConnections, tabId: number) {
	let tabConnection = websiteTabConnections.get(tabId)
	if (tabConnection === undefined) {
		tabConnection = { connections: {} }
		websiteTabConnections.set(tabId, tabConnection)
	}
	const current = getSignerCoordination(getSignerExecutionOwner(websiteTabConnections, tabId))
	if (current !== undefined) return current
	const state = createSignerCoordinationState()
	const owner: SignerExecutionOwner = Object.freeze({
		dispose: () => {
			state.selectionGate.releaseForTab(tabId)
			state.childSockets.clearTab(tabId)
			state.authoritativeTopSocketKeys.delete(tabId)
			state.signerExecutionAuthorities.delete(tabId)
		},
		socketDisconnected: (socket: WebsiteSocket) => {
			state.selectionGate.releaseForSocketKey(websiteSocketToString(socket))
			state.childSockets.scheduleRemoval(socket)
		},
	})
	tabConnection.signerExecutionOwner = owner
	signerCoordinationByOwner.set(owner, state)
	return state
}

export function registerCurrentChildSignerSocket(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, frameId: number) {
	if (isTopFrameId(frameId)) return false
	return initializeSignerCoordination(websiteTabConnections, socket.tabId).childSockets.register(socket, frameId)
}

export function unregisterCurrentChildSignerSocket(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket) {
	return getSignerCoordination(getSignerExecutionOwner(websiteTabConnections, socket.tabId))?.childSockets.unregister(socket) ?? false
}

export function scheduleCurrentChildSignerSocketRemoval(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket) {
	return getSignerCoordination(getSignerExecutionOwner(websiteTabConnections, socket.tabId))?.childSockets.scheduleRemoval(socket) ?? false
}

export function registerAuthoritativeTopSocket(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, websiteOrigin: string) {
	const { authoritativeTopSocketKeys, signerExecutionAuthorities } = initializeSignerCoordination(websiteTabConnections, socket.tabId)
	const key = websiteSocketToString(socket)
	const current = signerExecutionAuthorities.get(socket.tabId)
	if (authoritativeTopSocketKeys.get(socket.tabId) === key && current?.websiteOrigin === websiteOrigin) {
		return false
	}
	initializeSignerCoordination(websiteTabConnections, socket.tabId).selectionGate.releaseForTab(socket.tabId)
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

export function getSignerDocumentGenerationForOrigin(owner: SignerExecutionOwner | undefined, tabId: number, websiteOrigin: string) {
	const state = getSignerCoordination(owner)
	if (state === undefined) return undefined
	const { signerExecutionAuthorities } = state
	const authority = signerExecutionAuthorities.get(tabId)
	return authority?.websiteOrigin === websiteOrigin ? authority.documentGeneration : undefined
}

export function getSignerDocumentGeneration(owner: SignerExecutionOwner | undefined, socket: WebsiteSocket, websiteOrigin: string) {
	return isAuthoritativeTopSocket(owner, socket) ? getSignerDocumentGenerationForOrigin(owner, socket.tabId, websiteOrigin) : undefined
}

export function isCurrentChildSignerSocket(owner: SignerExecutionOwner | undefined, socket: WebsiteSocket, frameId: number | undefined) {
	return getSignerCoordination(owner)?.childSockets.isCurrent(socket, frameId) ?? false
}

export function reconcileSignerExecutionDocument(owner: SignerExecutionOwner | undefined, socket: WebsiteSocket, websiteOrigin: string, documentGeneration: string | undefined, isTopFrame: boolean, frameId: number | undefined) {
	const state = getSignerCoordination(owner)
	if (state === undefined) return false
	const { signerExecutionAuthorities } = state
	const authority = signerExecutionAuthorities.get(socket.tabId)
	const key = websiteSocketToString(socket)
	if (authority === undefined || authority.websiteOrigin !== websiteOrigin) return false
	if (isTopFrame) {
		if (!isAuthoritativeTopSocket(owner, socket)) return false
		authority.eligibleSocketKeys.add(key)
		return true
	}
	if (!isCurrentChildSignerSocket(owner, socket, frameId)) return false
	if (authority.documentGeneration !== documentGeneration) return false
	authority.eligibleSocketKeys.add(key)
	return true
}

export function isAuthoritativeTopSocket(owner: SignerExecutionOwner | undefined, socket: WebsiteSocket) {
	const state = getSignerCoordination(owner)
	if (state === undefined) return false
	const { authoritativeTopSocketKeys } = state
	return authoritativeTopSocketKeys.get(socket.tabId) === websiteSocketToString(socket)
}

export function setSignerExecutionTarget(owner: SignerExecutionOwner | undefined, tabId: number, providerUuid: string, websiteOrigin: string) {
	const state = getSignerCoordination(owner)
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

// Restoring an existing document cannot replace an active target or revive a deliberately blocked selection.
export function recoverSignerExecution(owner: SignerExecutionOwner | undefined, socket: WebsiteSocket, websiteOrigin: string, providerUuid: string | undefined) {
	const authority = getSignerCoordination(owner)?.signerExecutionAuthorities.get(socket.tabId)
	if (authority === undefined || !isAuthoritativeTopSocket(owner, socket)) return false
	if (authority.mode !== 'pending' && !(providerUuid === undefined ? authority.mode === 'legacy' : authority.mode === 'eip6963' && authority.providerUuid === providerUuid)) return false
	return providerUuid === undefined
		? allowLegacySignerExecution(owner, socket, websiteOrigin)
		: setSignerExecutionTarget(owner, socket.tabId, providerUuid, websiteOrigin) && authorizeSocketForSignerExecution(owner, socket, providerUuid, websiteOrigin)
}

export function allowLegacySignerExecution(owner: SignerExecutionOwner | undefined, socket: WebsiteSocket, websiteOrigin: string) {
	const state = getSignerCoordination(owner)
	if (state === undefined) return false
	const { signerExecutionAuthorities } = state
	if (!isAuthoritativeTopSocket(owner, socket)) return false
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

export function blockSignerExecution(owner: SignerExecutionOwner | undefined, tabId: number) {
	const state = getSignerCoordination(owner)
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

export function signerSelectionIsUnavailable(owner: SignerExecutionOwner | undefined, socket: WebsiteSocket, websiteOrigin: string) {
	const state = getSignerCoordination(owner)
	if (state === undefined) return false
	const { signerExecutionAuthorities } = state
	const authority = signerExecutionAuthorities.get(socket.tabId)
	return authority?.mode === 'blocked' && authority.websiteOrigin === websiteOrigin
}

export function signerExecutionIsPending(owner: SignerExecutionOwner | undefined, tabId: number, websiteOrigin: string) {
	const authority = getSignerCoordination(owner)?.signerExecutionAuthorities.get(tabId)
	return authority?.websiteOrigin === websiteOrigin && authority.mode === 'pending'
}

export function getSignerExecutionTargetForOrigin(owner: SignerExecutionOwner | undefined, tabId: number, websiteOrigin: string) {
	const state = getSignerCoordination(owner)
	if (state === undefined) return undefined
	const { signerExecutionAuthorities } = state
	const authority = signerExecutionAuthorities.get(tabId)
	if (authority?.mode !== 'eip6963' || authority.websiteOrigin !== websiteOrigin) return undefined
	return authority.providerUuid
}

export function getSignerExecutionTargetForSocket(owner: SignerExecutionOwner | undefined, socket: WebsiteSocket, websiteOrigin: string) {
	const state = getSignerCoordination(owner)
	if (state === undefined) return undefined
	const { signerExecutionAuthorities } = state
	const authority = signerExecutionAuthorities.get(socket.tabId)
	if (authority?.mode !== 'eip6963'
		|| authority.websiteOrigin !== websiteOrigin
		|| !authority.eligibleSocketKeys.has(websiteSocketToString(socket))) return undefined
	return authority.providerUuid
}

export function signerFrameHasDifferentOrigin(owner: SignerExecutionOwner | undefined, socket: WebsiteSocket, websiteOrigin: string) {
	const state = getSignerCoordination(owner)
	if (state === undefined) return false
	const { signerExecutionAuthorities } = state
	const authority = signerExecutionAuthorities.get(socket.tabId)
	return authority !== undefined && authority.websiteOrigin !== websiteOrigin
}

export function socketIsEligibleForSignerExecution(owner: SignerExecutionOwner | undefined, socket: WebsiteSocket, websiteOrigin: string) {
	const state = getSignerCoordination(owner)
	if (state === undefined) return false
	const { signerExecutionAuthorities } = state
	const authority = signerExecutionAuthorities.get(socket.tabId)
	return authority?.websiteOrigin === websiteOrigin && authority.eligibleSocketKeys.has(websiteSocketToString(socket))
}

export function authorizeSocketForSignerExecution(owner: SignerExecutionOwner | undefined, socket: WebsiteSocket, providerUuid: string, websiteOrigin: string) {
	const state = getSignerCoordination(owner)
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

export function authorizeSocketForLegacySignerExecution(owner: SignerExecutionOwner | undefined, socket: WebsiteSocket, websiteOrigin: string) {
	const state = getSignerCoordination(owner)
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

export function socketCanExecuteWithSelectedSigner(owner: SignerExecutionOwner | undefined, socket: WebsiteSocket) {
	const state = getSignerCoordination(owner)
	if (state === undefined) return false
	const { signerExecutionAuthorities, childSockets } = state
	const key = websiteSocketToString(socket)
	const authority = signerExecutionAuthorities.get(socket.tabId)
	if (authority?.authorizedSocketKeys.has(key) !== true) return false
	if (isAuthoritativeTopSocket(owner, socket)) return true
	return childSockets.containsCurrentSocket(socket)
}

export function clearSignerExecutionAuthorityForTab(websiteTabConnections: WebsiteTabConnections, tabId: number) {
	websiteTabConnections.get(tabId)?.signerExecutionOwner?.dispose()
}

export function getSignerExecutionError(owner: SignerExecutionOwner | undefined, socket: WebsiteSocket) {
	if (socketCanExecuteWithSelectedSigner(owner, socket)) return undefined
	return { code: METAMASK_ERROR_NOT_AUTHORIZED, message: 'The selected signer provider is not ready for this frame. Retry the request after wallet synchronization completes.' }
}

export function authorizeSignerForward(owner: SignerExecutionOwner | undefined, message: InterceptedRequestForward): InterceptedRequestForward {
	if (message.type !== 'forwardToSigner') return message
	const error = getSignerExecutionError(owner, message.uniqueRequestIdentifier.requestSocket)
	return error === undefined ? message : { ...message, type: 'result', error }
}

export async function acquireSignerSelectionLease(websiteTabConnections: WebsiteTabConnections, tabId: number, socket?: WebsiteSocket) {
	return await initializeSignerCoordination(websiteTabConnections, tabId).selectionGate.acquire(tabId, socket)
}

export function releaseSignerSelectionLease(websiteTabConnections: WebsiteTabConnections, tabId: number, token: string) {
	return getSignerCoordination(getSignerExecutionOwner(websiteTabConnections, tabId))?.selectionGate.release(tabId, token) ?? false
}

export function signerSelectionLeaseIsActive(websiteTabConnections: WebsiteTabConnections, tabId: number, token: string) {
	return getSignerCoordination(getSignerExecutionOwner(websiteTabConnections, tabId))?.selectionGate.isActive(tabId, token) ?? false
}

export function releaseSignerSelectionLeasesForSocket(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket) {
	getSignerCoordination(getSignerExecutionOwner(websiteTabConnections, socket.tabId))?.selectionGate.releaseForSocketKey(websiteSocketToString(socket))
}

export async function runWithSignerSelectionGate<T>(websiteTabConnections: WebsiteTabConnections, tabId: number, action: () => Promise<T>) {
	return await initializeSignerCoordination(websiteTabConnections, tabId).selectionGate.run(tabId, action)
}
