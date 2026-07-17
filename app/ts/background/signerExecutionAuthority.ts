import { EthereumQuantity, serialize } from '../types/wire-types.js'
import type { WebsiteSocket } from '../utils/requests.js'

const socketKey = (socket: WebsiteSocket) => `${ socket.tabId }-${ serialize(EthereumQuantity, socket.connectionName) }`

type SignerExecutionAuthority = {
	readonly websiteOrigin: string
	documentGeneration: string | undefined
	readonly mode: 'blocked' | 'legacy' | 'eip6963'
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
	if (frameId === 0) return false
	const key = socketKey(socket)
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
	const key = socketKey(socket)
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
	const key = socketKey(socket)
	if (!childFrameIdsBySocketKey.has(key) || pendingChildSocketRemovalTimers.has(key)) return false
	const timeout = setTimeout(() => {
		pendingChildSocketRemovalTimers.delete(key)
		unregisterCurrentChildSignerSocket(socket)
	}, 1000)
	pendingChildSocketRemovalTimers.set(key, timeout)
	return true
}

export function registerAuthoritativeTopSocket(socket: WebsiteSocket, websiteOrigin: string) {
	const key = socketKey(socket)
	const current = signerExecutionAuthorities.get(socket.tabId)
	if (authoritativeTopSocketKeys.get(socket.tabId) === key && current?.websiteOrigin === websiteOrigin) {
		current.eligibleSocketKeys.add(key)
		return false
	}
	authoritativeTopSocketKeys.set(socket.tabId, key)
	// Every document starts blocked until its initial (possibly empty) EIP-6963
	// catalog has been reconciled with the site's stored preference.
	signerExecutionAuthorities.set(socket.tabId, {
		websiteOrigin,
		documentGeneration: undefined,
		mode: 'blocked',
		providerUuid: undefined,
		eligibleSocketKeys: new Set([key]),
		authorizedSocketKeys: new Set(),
	})
	return true
}

export function reconcileSignerExecutionDocument(socket: WebsiteSocket, websiteOrigin: string, documentGeneration: string, isTopFrame: boolean, frameId: number | undefined) {
	const authority = signerExecutionAuthorities.get(socket.tabId)
	const key = socketKey(socket)
	if (authority === undefined || authority.websiteOrigin !== websiteOrigin) return false
	if (isTopFrame) {
		if (!isAuthoritativeTopSocket(socket)) return false
		authority.documentGeneration = documentGeneration
		authority.eligibleSocketKeys.add(key)
		return true
	}
	if (frameId === undefined || frameId === 0 || currentChildSocketKeysByTab.get(socket.tabId)?.get(frameId) !== key) return false
	if (authority.documentGeneration !== documentGeneration) return false
	authority.eligibleSocketKeys.add(key)
	return true
}

export function isAuthoritativeTopSocket(socket: WebsiteSocket) {
	return authoritativeTopSocketKeys.get(socket.tabId) === socketKey(socket)
}

export function setSignerExecutionTarget(tabId: number, providerUuid: string, websiteOrigin: string) {
	const current = signerExecutionAuthorities.get(tabId)
	if (current === undefined || current.websiteOrigin !== websiteOrigin || current.documentGeneration === undefined) return false
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
	if (current === undefined || current.websiteOrigin !== websiteOrigin || current.documentGeneration === undefined || !current.eligibleSocketKeys.has(socketKey(socket))) return false
	if (current.mode === 'legacy') {
		current.authorizedSocketKeys.add(socketKey(socket))
		return true
	}
	signerExecutionAuthorities.set(socket.tabId, {
		websiteOrigin,
		documentGeneration: current.documentGeneration,
		mode: 'legacy',
		providerUuid: undefined,
		eligibleSocketKeys: current.eligibleSocketKeys,
		authorizedSocketKeys: new Set([socketKey(socket)]),
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

export function getSignerExecutionTargetForOrigin(tabId: number, websiteOrigin: string) {
	const authority = signerExecutionAuthorities.get(tabId)
	if (authority?.mode !== 'eip6963' || authority.websiteOrigin !== websiteOrigin) return undefined
	return authority.providerUuid
}

export function getSignerExecutionTargetForSocket(socket: WebsiteSocket, websiteOrigin: string) {
	const authority = signerExecutionAuthorities.get(socket.tabId)
	if (authority?.mode !== 'eip6963'
		|| authority.websiteOrigin !== websiteOrigin
		|| !authority.eligibleSocketKeys.has(socketKey(socket))) return undefined
	return authority.providerUuid
}

export function socketIsEligibleForSignerExecution(socket: WebsiteSocket, websiteOrigin: string) {
	const authority = signerExecutionAuthorities.get(socket.tabId)
	return authority?.websiteOrigin === websiteOrigin && authority.eligibleSocketKeys.has(socketKey(socket))
}

export function authorizeSocketForSignerExecution(socket: WebsiteSocket, providerUuid: string, websiteOrigin: string) {
	const authority = signerExecutionAuthorities.get(socket.tabId)
	const key = socketKey(socket)
	if (authority?.mode !== 'eip6963'
		|| authority.providerUuid !== providerUuid
		|| authority.websiteOrigin !== websiteOrigin
		|| !authority.eligibleSocketKeys.has(key)) return false
	authority.authorizedSocketKeys.add(key)
	return true
}

export function authorizeSocketForLegacySignerExecution(socket: WebsiteSocket, websiteOrigin: string) {
	const authority = signerExecutionAuthorities.get(socket.tabId)
	const key = socketKey(socket)
	if (authority?.mode !== 'legacy'
		|| authority.websiteOrigin !== websiteOrigin
		|| !authority.eligibleSocketKeys.has(key)) return false
	authority.authorizedSocketKeys.add(key)
	return true
}

export function socketCanExecuteWithSelectedSigner(socket: WebsiteSocket) {
	const key = socketKey(socket)
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
