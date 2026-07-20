import type { TabConnection, TabState, WebsiteTabConnections } from '../types/user-interface-types.js'
import type { InpageScriptCallBack, Settings } from '../types/interceptor-messages.js'
import type { WebsiteSocket } from '../utils/requests.js'
import { createScopedKeyedSerialExecutor } from '../utils/semaphore.js'
import { modifyObject } from '../utils/typescript.js'
import { sendInternalWindowMessage, websiteSocketToString } from './backgroundUtils.js'
import { updateTabState } from './storageVariables.js'
import { METAMASK_ERROR_PROVIDER_DISCONNECTED } from '../utils/constants.js'
import { sendSubscriptionReplyOrCallBackToPort } from './messageSending.js'

const SIGNER_STATE_CONFIRMATION_TIMEOUT_MS = 3_000
const serializeSignerStateOperation = createScopedKeyedSerialExecutor<WebsiteTabConnections, number>()
const signerStateReplacementListeners = new Set<(signerStateToken: SignerStateToken, error: typeof signerConnectionReplacedError) => void>()

export const signerConnectionReplacedError = {
	code: METAMASK_ERROR_PROVIDER_DISCONNECTED,
	message: 'Signer connection changed before the previous wallet replied.',
}

export const signerUnavailableError = {
	code: METAMASK_ERROR_PROVIDER_DISCONNECTED,
	message: 'No signer wallet is available to this page. Enable your wallet extension for this site, then try again.',
}

export type SignerStateToken = {
	readonly socket: WebsiteSocket
	readonly port: browser.runtime.Port
	readonly ownerGeneration: number
	readonly signerProviderGeneration: number
}

export function doSignerStateTokensMatch(first: SignerStateToken, second: SignerStateToken) {
	return first.socket.tabId === second.socket.tabId
		&& first.socket.connectionName === second.socket.connectionName
		&& first.port === second.port
		&& first.ownerGeneration === second.ownerGeneration
		&& first.signerProviderGeneration === second.signerProviderGeneration
}

function createSignerStateConfirmation() {
	let resolveConfirmation: (() => void) | undefined
	const promise = new Promise<void>((resolve) => { resolveConfirmation = resolve })
	return {
		promise,
		resolve: () => resolveConfirmation?.(),
	}
}

export function settleSignerRequestsForReplacedState(signerStateToken: SignerStateToken | undefined, error = signerConnectionReplacedError) {
	if (signerStateToken === undefined) return
	sendInternalWindowMessage({
		method: 'window_signer_accounts_changed',
		data: {
			socket: signerStateToken.socket,
			signerStateOwnerGeneration: signerStateToken.ownerGeneration,
			signerProviderGeneration: signerStateToken.signerProviderGeneration,
			error,
		},
	})
	for (const listener of signerStateReplacementListeners) listener(signerStateToken, error)
}

export function addSignerStateReplacementListener(listener: (signerStateToken: SignerStateToken, error: typeof signerConnectionReplacedError) => void) {
	signerStateReplacementListeners.add(listener)
	return () => signerStateReplacementListeners.delete(listener)
}

export function clearSignerDerivedTabState(previousState: TabState) {
	return modifyObject(previousState, {
		signerConnected: false,
		signerName: 'NoSigner',
		signerAccounts: [],
		signerChain: undefined,
		signerAccountError: undefined,
		activeSigningAddress: undefined,
	})
}

export async function runSignerStateOperation<T>(websiteTabConnections: WebsiteTabConnections, tabId: number, operation: () => Promise<T>) {
	return await serializeSignerStateOperation(websiteTabConnections, tabId, operation)
}

export function isCurrentWebsiteConnection(tabConnection: TabConnection | undefined, socket: WebsiteSocket, port: browser.runtime.Port) {
	return tabConnection?.connections[websiteSocketToString(socket)]?.port === port
}

export function advanceSignerStateGeneration(tabConnection: TabConnection) {
	const signerStateOwner = tabConnection.signerStateOwner ?? { confirmed: false, generation: 0 }
	tabConnection.signerStateOwner = signerStateOwner
	signerStateOwner.generation += 1
	return signerStateOwner.generation
}

export function resolveSignerStateConfirmation(tabConnection: TabConnection) {
	tabConnection.signerStateOwner?.confirmation?.resolve()
	if (tabConnection.signerStateOwner !== undefined) tabConnection.signerStateOwner.confirmation = undefined
}

export function beginSignerStateConfirmation(tabConnection: TabConnection) {
	resolveSignerStateConfirmation(tabConnection)
	advanceSignerStateGeneration(tabConnection)
	if (tabConnection.signerStateOwner === undefined) throw new Error('Signer state owner lifecycle missing')
	tabConnection.signerStateOwner.confirmed = false
	tabConnection.signerStateOwner.confirmation = createSignerStateConfirmation()
}

export function confirmSignerState(tabConnection: TabConnection, signerProviderGeneration: number) {
	if (tabConnection.signerStateOwner === undefined) throw new Error('Signer state owner lifecycle missing')
	tabConnection.signerStateOwner.providerGeneration = signerProviderGeneration
	tabConnection.signerStateOwner.confirmed = true
	resolveSignerStateConfirmation(tabConnection)
}

function provisionallyClaimSignerStateOwnerWithinOperation(tabConnection: TabConnection, socket: WebsiteSocket) {
	beginSignerStateConfirmation(tabConnection)
	if (tabConnection.signerStateOwner === undefined) throw new Error('Signer state owner lifecycle missing')
	tabConnection.signerStateOwner.connectionName = socket.connectionName
	tabConnection.signerStateOwner.providerGeneration = undefined
}

export async function registerWebsiteConnectionAndProvisionallyClaimSignerState(
	websiteTabConnections: WebsiteTabConnections,
	socket: WebsiteSocket,
	connection: TabConnection['connections'][string],
	isTopFrame: boolean,
) {
	return await runSignerStateOperation(websiteTabConnections, socket.tabId, async () => {
		let tabConnection = websiteTabConnections.get(socket.tabId)
		const createdTabConnection = tabConnection === undefined
		if (tabConnection === undefined) {
			tabConnection = { connections: {} }
			websiteTabConnections.set(socket.tabId, tabConnection)
		}
		const previousSignerStateToken = isTopFrame ? getConfirmedSignerStateToken(websiteTabConnections, socket.tabId) : undefined
		tabConnection.connections[websiteSocketToString(socket)] = connection
		if (isTopFrame) {
			provisionallyClaimSignerStateOwnerWithinOperation(tabConnection, socket)
			settleSignerRequestsForReplacedState(previousSignerStateToken)
			await updateTabState(socket.tabId, clearSignerDerivedTabState)
		}
		return { createdTabConnection, provisionallyClaimedSignerState: isTopFrame }
	})
}

export function getConfirmedSignerStateToken(websiteTabConnections: WebsiteTabConnections, tabId: number): SignerStateToken | undefined {
	const tabConnection = websiteTabConnections.get(tabId)
	if (tabConnection === undefined) return undefined
	const signerStateOwner = tabConnection.signerStateOwner
	if (signerStateOwner?.confirmed !== true) return undefined
	const connectionName = signerStateOwner.connectionName
	const ownerGeneration = signerStateOwner.generation
	const signerProviderGeneration = signerStateOwner.providerGeneration
	if (connectionName === undefined || ownerGeneration === undefined || signerProviderGeneration === undefined) return undefined
	const socket = { tabId, connectionName }
	const port = tabConnection.connections[websiteSocketToString(socket)]?.port
	if (port === undefined) return undefined
	return { socket, port, ownerGeneration, signerProviderGeneration }
}

export function isSignerStateTokenCurrent(websiteTabConnections: WebsiteTabConnections, token: SignerStateToken) {
	const currentToken = getConfirmedSignerStateToken(websiteTabConnections, token.socket.tabId)
	return currentToken !== undefined && doSignerStateTokensMatch(currentToken, token)
}

export async function getActiveAddressForCurrentSignerState<T>(
	websiteTabConnections: WebsiteTabConnections,
	settings: Pick<Settings, 'simulationMode' | 'useSignersAddressAsActiveAddress'>,
	tabId: number,
	getAddress: () => Promise<T | undefined>,
): Promise<T | undefined> {
	if (settings.simulationMode && !settings.useSignersAddressAsActiveAddress) return await getAddress()
	const signerStateToken = getConfirmedSignerStateToken(websiteTabConnections, tabId)
	if (signerStateToken === undefined) return undefined
	const activeAddress = await getAddress()
	return isSignerStateTokenCurrent(websiteTabConnections, signerStateToken) ? activeAddress : undefined
}

export function tabHasApprovedWebsiteConnection(websiteTabConnections: WebsiteTabConnections, tabId: number) {
	return Object.values(websiteTabConnections.get(tabId)?.connections ?? {}).some((connection) => connection.approved)
}

export function sendCallbackToConfirmedSignerOwner(websiteTabConnections: WebsiteTabConnections, tabId: number, message: InpageScriptCallBack) {
	const signerStateToken = getConfirmedSignerStateToken(websiteTabConnections, tabId)
	if (signerStateToken === undefined) return false
	const tabConnection = websiteTabConnections.get(tabId)
	const ownerConnection = tabConnection?.connections[websiteSocketToString(signerStateToken.socket)]
	if (!tabHasApprovedWebsiteConnection(websiteTabConnections, tabId) || ownerConnection?.port !== signerStateToken.port) return false
	return sendSubscriptionReplyOrCallBackToPort(signerStateToken.port, { type: 'result', ...message }) ? signerStateToken : false
}

export function sendCallbackToAllConfirmedSignerOwners(websiteTabConnections: WebsiteTabConnections, message: InpageScriptCallBack) {
	let sentCount = 0
	for (const tabId of websiteTabConnections.keys()) {
		if (sendCallbackToConfirmedSignerOwner(websiteTabConnections, tabId, message)) sentCount += 1
	}
	return sentCount
}

export async function waitForConfirmedSignerStateToken(websiteTabConnections: WebsiteTabConnections, tabId: number): Promise<SignerStateToken | undefined> {
	const deadline = Date.now() + SIGNER_STATE_CONFIRMATION_TIMEOUT_MS
	for (;;) {
		const token = getConfirmedSignerStateToken(websiteTabConnections, tabId)
		if (token !== undefined) return token
		const confirmation = websiteTabConnections.get(tabId)?.signerStateOwner?.confirmation
		if (confirmation === undefined) return undefined
		const remainingTime = deadline - Date.now()
		if (remainingTime <= 0) return undefined
		let timedOut = false
		let timeout: ReturnType<typeof setTimeout> | undefined
		try {
			await Promise.race([
				confirmation.promise,
				new Promise<void>((resolve) => {
					timeout = setTimeout(() => {
						timedOut = true
						resolve()
					}, remainingTime)
				}),
			])
		} finally {
			if (timeout !== undefined) clearTimeout(timeout)
		}
		if (timedOut) return undefined
	}
}
