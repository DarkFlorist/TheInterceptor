import { createChildSignerSockets } from './childSignerSockets.js'
import { createSignerSelectionGate } from './signerSelectionGate.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
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
	readonly selectionGate: ReturnType<typeof createSignerSelectionGate>
	readonly childSockets: ReturnType<typeof createChildSignerSockets>
	readonly authoritativeTopSocketKeys: Map<number, string>
	readonly signerExecutionAuthorities: Map<number, SignerExecutionAuthority>
}

// One collection-scoped owner holds document authority and selection reservations privately, so copying connection/UI snapshots cannot grant execution. TabState is persisted display data; signerStateOwner tracks callback freshness rather than execution permission.
const signerCoordinationByConnections = new WeakMap<WebsiteTabConnections, SignerCoordinationState>()

// Registration and workflow reservations initialize this collection's ephemeral state; queries never attach state. Persisted TabState is a UI/catalog snapshot and never grants execution authority.
function createSignerCoordinationState(): SignerCoordinationState {
	const signerExecutionAuthorities = new Map<number, SignerExecutionAuthority>()
	const selectionGate = createSignerSelectionGate()
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

function initializeSignerCoordination(websiteTabConnections: WebsiteTabConnections) {
	const current = signerCoordinationByConnections.get(websiteTabConnections)
	if (current !== undefined) return current
	const state = createSignerCoordinationState()
	signerCoordinationByConnections.set(websiteTabConnections, state)
	return state
}

export function registerCurrentChildSignerSocket(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, frameId: number) {
	if (isTopFrameId(frameId)) return false
	return initializeSignerCoordination(websiteTabConnections).childSockets.register(socket, frameId)
}

export function unregisterCurrentChildSignerSocket(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket) {
	return signerCoordinationByConnections.get(websiteTabConnections)?.childSockets.unregister(socket) ?? false
}

export function scheduleCurrentChildSignerSocketRemoval(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket) {
	return signerCoordinationByConnections.get(websiteTabConnections)?.childSockets.scheduleRemoval(socket) ?? false
}

export function registerAuthoritativeTopSocket(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, websiteOrigin: string) {
	const { authoritativeTopSocketKeys, signerExecutionAuthorities } = initializeSignerCoordination(websiteTabConnections)
	const key = websiteSocketToString(socket)
	const current = signerExecutionAuthorities.get(socket.tabId)
	if (authoritativeTopSocketKeys.get(socket.tabId) === key && current?.websiteOrigin === websiteOrigin) {
		return false
	}
	initializeSignerCoordination(websiteTabConnections).selectionGate.releaseForTab(socket.tabId)
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
	return signerCoordinationByConnections.get(websiteTabConnections)?.childSockets.isCurrent(socket, frameId) ?? false
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
	const { signerExecutionAuthorities, childSockets } = state
	const key = websiteSocketToString(socket)
	const authority = signerExecutionAuthorities.get(socket.tabId)
	if (authority?.authorizedSocketKeys.has(key) !== true) return false
	if (isAuthoritativeTopSocket(websiteTabConnections, socket)) return true
	return childSockets.containsCurrentSocket(socket)
}

export function clearSignerExecutionAuthorityForTab(websiteTabConnections: WebsiteTabConnections, tabId: number) {
	const state = signerCoordinationByConnections.get(websiteTabConnections)
	if (state === undefined) return
	state.selectionGate.releaseForTab(tabId)
	state.childSockets.clearTab(tabId)
	state.authoritativeTopSocketKeys.delete(tabId)
	state.signerExecutionAuthorities.delete(tabId)
	// Keep the owner alive while queued reservations drain; policy reads never initialize it.
	if (state.authoritativeTopSocketKeys.size === 0 && state.signerExecutionAuthorities.size === 0 && state.childSockets.isEmpty() && state.selectionGate.isIdle()) signerCoordinationByConnections.delete(websiteTabConnections)
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

export async function acquireSignerSelectionLease(websiteTabConnections: WebsiteTabConnections, tabId: number, socket?: WebsiteSocket) {
	return await initializeSignerCoordination(websiteTabConnections).selectionGate.acquire(tabId, socket)
}

export function releaseSignerSelectionLease(websiteTabConnections: WebsiteTabConnections, tabId: number, token: string) {
	return signerCoordinationByConnections.get(websiteTabConnections)?.selectionGate.release(tabId, token) ?? false
}

export function signerSelectionLeaseIsActive(websiteTabConnections: WebsiteTabConnections, tabId: number, token: string) {
	return signerCoordinationByConnections.get(websiteTabConnections)?.selectionGate.isActive(tabId, token) ?? false
}

export function releaseSignerSelectionLeasesForSocket(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket) {
	signerCoordinationByConnections.get(websiteTabConnections)?.selectionGate.releaseForSocketKey(websiteSocketToString(socket))
}

export async function runWithSignerSelectionGate<T>(websiteTabConnections: WebsiteTabConnections, tabId: number, action: () => Promise<T>) {
	return await initializeSignerCoordination(websiteTabConnections).selectionGate.run(tabId, action)
}
