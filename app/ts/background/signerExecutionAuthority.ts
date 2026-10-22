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

const authoritativeTopSocketKeys = new Map<number, string>()
const signerExecutionAuthorities = new Map<number, SignerExecutionAuthority>()
const currentChildSocketKeysByTab = new Map<number, Map<number, string>>()
const childFrameIdsBySocketKey = new Map<string, number>()
const pendingChildSocketRemovalTimers = new Map<string, ReturnType<typeof setTimeout>>()

export function registerCurrentChildSignerSocket(socket: WebsiteSocket, frameId: number) {
	if (isTopFrameId(frameId)) return false
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
		childFrameIdsBySocketKey.delete(previousKey)
		authority?.eligibleSocketKeys.delete(previousKey)
		authority?.authorizedSocketKeys.delete(previousKey)
	}
	return true
}

export function unregisterCurrentChildSignerSocket(socket: WebsiteSocket) {
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

export function scheduleCurrentChildSignerSocketRemoval(socket: WebsiteSocket) {
	const key = websiteSocketToString(socket)
	if (!childFrameIdsBySocketKey.has(key) || pendingChildSocketRemovalTimers.has(key)) return false
	const timeout = setTimeout(() => {
		pendingChildSocketRemovalTimers.delete(key)
		unregisterCurrentChildSignerSocket(socket)
	}, 1000)
	pendingChildSocketRemovalTimers.set(key, timeout)
	return true
}

export function registerAuthoritativeTopSocket(socket: WebsiteSocket, websiteOrigin: string) {
	const key = websiteSocketToString(socket)
	const current = signerExecutionAuthorities.get(socket.tabId)
	if (authoritativeTopSocketKeys.get(socket.tabId) === key && current?.websiteOrigin === websiteOrigin) {
		return false
	}
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


export function getSignerDocumentGenerationForOrigin(tabId: number, websiteOrigin: string) {
	const authority = signerExecutionAuthorities.get(tabId)
	return authority?.websiteOrigin === websiteOrigin ? authority.documentGeneration : undefined
}

export function getSignerDocumentGeneration(socket: WebsiteSocket, websiteOrigin: string) {
	return isAuthoritativeTopSocket(socket) ? getSignerDocumentGenerationForOrigin(socket.tabId, websiteOrigin) : undefined
}

export function isCurrentChildSignerSocket(socket: WebsiteSocket, frameId: number | undefined) {
	return frameId !== undefined && !isTopFrameId(frameId) && currentChildSocketKeysByTab.get(socket.tabId)?.get(frameId) === websiteSocketToString(socket)
}

export function reconcileSignerExecutionDocument(socket: WebsiteSocket, websiteOrigin: string, documentGeneration: string | undefined, isTopFrame: boolean, frameId: number | undefined) {
	const authority = signerExecutionAuthorities.get(socket.tabId)
	const key = websiteSocketToString(socket)
	if (authority === undefined || authority.websiteOrigin !== websiteOrigin) return false
	if (isTopFrame) {
		if (!isAuthoritativeTopSocket(socket)) return false
		authority.eligibleSocketKeys.add(key)
		return true
	}
	if (!isCurrentChildSignerSocket(socket, frameId)) return false
	if (authority.documentGeneration !== documentGeneration) return false
	authority.eligibleSocketKeys.add(key)
	return true
}

export function isAuthoritativeTopSocket(socket: WebsiteSocket) {
	return authoritativeTopSocketKeys.get(socket.tabId) === websiteSocketToString(socket)
}

export function setSignerExecutionTarget(tabId: number, providerUuid: string, websiteOrigin: string) {
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

export function allowLegacySignerExecution(socket: WebsiteSocket, websiteOrigin: string) {
	if (!isAuthoritativeTopSocket(socket)) return false
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

export function blockSignerExecution(tabId: number) {
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

export function signerSelectionIsUnavailable(socket: WebsiteSocket, websiteOrigin: string) {
	const authority = signerExecutionAuthorities.get(socket.tabId)
	return authority?.mode === 'blocked' && authority.websiteOrigin === websiteOrigin
}

export function getSignerExecutionTargetForOrigin(tabId: number, websiteOrigin: string) {
	const authority = signerExecutionAuthorities.get(tabId)
	if (authority?.mode !== 'eip6963' || authority.websiteOrigin !== websiteOrigin) return undefined
	return authority.providerUuid
}

export function getSignerExecutionTargetForSocket(socket: WebsiteSocket, websiteOrigin: string) {
	const authority = signerExecutionAuthorities.get(socket.tabId)
	if (authority?.mode !== 'eip6963'
		|| authority.websiteOrigin !== websiteOrigin
		|| !authority.eligibleSocketKeys.has(websiteSocketToString(socket))) return undefined
	return authority.providerUuid
}

export function signerFrameHasDifferentOrigin(socket: WebsiteSocket, websiteOrigin: string) {
	const authority = signerExecutionAuthorities.get(socket.tabId)
	return authority !== undefined && authority.websiteOrigin !== websiteOrigin
}

export function socketIsEligibleForSignerExecution(socket: WebsiteSocket, websiteOrigin: string) {
	const authority = signerExecutionAuthorities.get(socket.tabId)
	return authority?.websiteOrigin === websiteOrigin && authority.eligibleSocketKeys.has(websiteSocketToString(socket))
}

export function authorizeSocketForSignerExecution(socket: WebsiteSocket, providerUuid: string, websiteOrigin: string) {
	const authority = signerExecutionAuthorities.get(socket.tabId)
	const key = websiteSocketToString(socket)
	if (authority?.mode !== 'eip6963'
		|| authority.providerUuid !== providerUuid
		|| authority.websiteOrigin !== websiteOrigin
		|| !authority.eligibleSocketKeys.has(key)) return false
	authority.authorizedSocketKeys.add(key)
	return true
}

export function authorizeSocketForLegacySignerExecution(socket: WebsiteSocket, websiteOrigin: string) {
	const authority = signerExecutionAuthorities.get(socket.tabId)
	const key = websiteSocketToString(socket)
	if (authority?.mode !== 'legacy'
		|| authority.websiteOrigin !== websiteOrigin
		|| !authority.eligibleSocketKeys.has(key)) return false
	authority.authorizedSocketKeys.add(key)
	return true
}

export function socketCanExecuteWithSelectedSigner(socket: WebsiteSocket) {
	const key = websiteSocketToString(socket)
	const authority = signerExecutionAuthorities.get(socket.tabId)
	if (authority?.authorizedSocketKeys.has(key) !== true) return false
	if (isAuthoritativeTopSocket(socket)) return true
	const frameId = childFrameIdsBySocketKey.get(key)
	return frameId !== undefined && currentChildSocketKeysByTab.get(socket.tabId)?.get(frameId) === key
}

export function clearSignerExecutionAuthorityForTab(tabId: number) {
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
}

export function getSignerExecutionError(socket: WebsiteSocket) {
	if (socketCanExecuteWithSelectedSigner(socket)) return undefined
	return { code: METAMASK_ERROR_NOT_AUTHORIZED, message: 'The selected signer provider is not ready for this frame. Retry the request after wallet synchronization completes.' }
}

export function authorizeSignerForward(message: InterceptedRequestForward): InterceptedRequestForward {
	if (message.type !== 'forwardToSigner') return message
	const error = getSignerExecutionError(message.uniqueRequestIdentifier.requestSocket)
	return error === undefined ? message : { ...message, type: 'result', error }
}
