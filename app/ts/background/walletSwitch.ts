import { getConfiguredSigningSafe } from './signingAddressSelection.js'
import { bumpPopupRefreshGeneration } from './popupRefreshGeneration.js'
import { getSettings } from './settings.js'
import { JSON_RPC_ERROR_CODE_INTERNAL_ERROR, METAMASK_ERROR_USER_REJECTED_REQUEST } from '../utils/constants.js'
import { Future } from '../utils/future.js'
import type { SignerChainChangeConfirmation, WalletSwitchEthereumChainReply } from '../types/interceptor-messages.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { changeActiveAddressAndChain } from './activeSettings.js'
import { getSocketFromPort, sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { promoteRpcAsPrimary, getTabState } from './storageVariables.js'
import { getRpcNetworkChange, getRpcChangeRoute } from '../utils/rpcNetworkChange.js'
import type { RpcNetwork } from '../types/rpc.js'
import type { SimulationServicesOwner } from '../simulation/serviceLifecycle.js'
import { sendCallbackToConfirmedSignerOwner, getConfirmedSignerStateToken, runSignerStateOperation, signerConnectionReplacedError, addSignerStateReplacementListener, doSignerStateTokensMatch, signerUnavailableError, type SignerStateToken } from './signerStateOwnership.js'

type PendingSignerChainChange = {
	readonly walletSwitchRequestId: string
	readonly future: Future<
		| { readonly type: 'reply', readonly confirmation: SignerChainChangeConfirmation }
		| { readonly type: 'replacement', readonly error: typeof signerUnavailableError }
		| { readonly type: 'timeout' }
	>
	readonly receivedReplyTokens: SignerStateToken[]
	timeout: ReturnType<typeof setTimeout> | undefined
	readonly requestTabId: number
	readonly requestedRpcNetwork: RpcNetwork
	signerStateToken: SignerStateToken | undefined
	readonly repliesBeforeToken: Array<{ readonly signerStateToken: SignerStateToken, readonly confirmation: SignerChainChangeConfirmation }>
	readonly replacementsBeforeToken: Array<{ readonly signerStateToken: SignerStateToken, readonly error: typeof signerUnavailableError }>
}

let pendingSignerChainChange: PendingSignerChainChange | undefined
const WALLET_SWITCH_TIMEOUT_MS = 120_000

// Command IDs isolate replies across popup/dapp requests, including retries after a deadline.
function isPendingWalletSwitchRequest(walletSwitchRequestId: string) {
	return pendingSignerChainChange?.walletSwitchRequestId === walletSwitchRequestId
}

function markSignerChainReplyReceived(token: SignerStateToken, chainId: bigint, walletSwitchRequestId: string) {
	const pending = pendingSignerChainChange
	if (pending !== undefined && pending.walletSwitchRequestId === walletSwitchRequestId && doesPendingSignerChainChangeMatch(pending, token, chainId)) {
		// Early delivery cannot disarm the deadline until the dispatched request's token is known.
		if (pending.signerStateToken === undefined) pending.receivedReplyTokens.push(token)
		else clearTimeout(pending.timeout)
	}
}

export const isSignerChainChangePending = () => pendingSignerChainChange !== undefined

function doesPendingSignerChainChangeMatch(pending: PendingSignerChainChange, signerStateToken: SignerStateToken, chainId: bigint) {
	if (pending.requestedRpcNetwork.chainId !== chainId) return false
	return pending.signerStateToken === undefined
		? pending.requestTabId === signerStateToken.socket.tabId
		: doSignerStateTokensMatch(pending.signerStateToken, signerStateToken)
}

function getPendingSignerChainChangeTokenForCallback(port: browser.runtime.Port, signerProviderGeneration: number, chainId: bigint) {
	const signerStateToken = pendingSignerChainChange?.signerStateToken
	if (signerStateToken === undefined || pendingSignerChainChange?.requestedRpcNetwork.chainId !== chainId) return undefined
	if (signerStateToken.port !== port || signerStateToken.signerProviderGeneration !== signerProviderGeneration) return undefined
	return signerStateToken
}

function isPendingSignerChainChangeReply(signerStateToken: SignerStateToken, chainId: bigint) {
	return pendingSignerChainChange !== undefined && doesPendingSignerChainChangeMatch(pendingSignerChainChange, signerStateToken, chainId)
}

// Keep the requested endpoint in memory until the matching wallet accepts; a rejected request must not change RPC preferences.
function getPendingSignerChainChangeRpc(signerStateToken: SignerStateToken, chainId: bigint) {
	const pending = pendingSignerChainChange
	return pending !== undefined && doesPendingSignerChainChangeMatch(pending, signerStateToken, chainId) ? pending.requestedRpcNetwork : undefined
}

function resolveSignerChainChange(signerStateToken: SignerStateToken, confirmation: SignerChainChangeConfirmation) {
	if (!isPendingWalletSwitchRequest(confirmation.data[0].walletSwitchRequestId)) return false
	markSignerChainReplyReceived(signerStateToken, confirmation.data[0].chainId, confirmation.data[0].walletSwitchRequestId)
	const pending = pendingSignerChainChange
	if (pending === undefined || !doesPendingSignerChainChangeMatch(pending, signerStateToken, confirmation.data[0].chainId)) return false
	if (pending.signerStateToken === undefined) {
		pending.repliesBeforeToken.push({ signerStateToken, confirmation })
		return true
	}
	pending.future.resolve({ type: 'reply', confirmation })
	return true
}

export type RpcSwitchResult = { readonly result: null, readonly error?: undefined } | { readonly error: { readonly code: number, readonly message: string, readonly data?: string }, readonly result?: undefined }

export type RpcSwitchRequest =
	| { readonly source: 'popup', readonly signerTabId: number | undefined }
	| { readonly source: 'dapp', readonly signerTabId: number | undefined, readonly simulationMode: boolean }

// One command owns routing, Safe network restrictions, local promotion and correlated wallet dispatch.
export async function changeActiveRpc(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, rpcNetwork: RpcNetwork, request: RpcSwitchRequest, timeoutMs = WALLET_SWITCH_TIMEOUT_MS): Promise<RpcSwitchResult> {
	const settings = await getSettings()
	const simulationMode = request.source === 'popup' ? settings.simulationMode : request.simulationMode
	const route = getRpcChangeRoute(settings.activeRpcNetwork, rpcNetwork, simulationMode)
	if (route !== 'wallet') {
		if (route === 'local') {
			await changeActiveAddressAndChain(simulationServicesOwner, websiteTabConnections, { simulationMode, rpcNetwork })
		}
		await promoteRpcAsPrimary(rpcNetwork)
		return { result: null }
	}
	if (request.signerTabId === undefined) return { error: signerUnavailableError }
	// A selected Safe pins the active chain for both popup and dapp requests. Reject before the wallet can diverge.
	if (await getConfiguredSigningSafe(settings, (await getTabState(request.signerTabId)).signerAccounts) !== undefined) {
		return { error: { code: METAMASK_ERROR_USER_REJECTED_REQUEST, message: 'This Safe is tied to its current network. Select your wallet account before switching networks.' } }
	}
	return await requestSignerChainChange(websiteTabConnections, rpcNetwork, request.signerTabId, timeoutMs)
}

async function requestSignerChainChange(websiteTabConnections: WebsiteTabConnections, rpcNetwork: RpcNetwork, requestTabId: number, timeoutMs: number) {
	if (pendingSignerChainChange !== undefined) return { error: { code: -32002, message: 'A network switch is already waiting for your wallet.' } }
	const pending: PendingSignerChainChange = {
		walletSwitchRequestId: crypto.randomUUID(),
		receivedReplyTokens: [],
		timeout: undefined,
		future: new Future<
			| { readonly type: 'reply', readonly confirmation: SignerChainChangeConfirmation }
			| { readonly type: 'replacement', readonly error: typeof signerUnavailableError }
			| { readonly type: 'timeout' }
		>(),
		requestTabId: requestTabId,
		requestedRpcNetwork: rpcNetwork,
		signerStateToken: undefined,
		repliesBeforeToken: [],
		replacementsBeforeToken: [],
	}
	const removeReplacementListener = addSignerStateReplacementListener((signerStateToken, error) => {
		if (pending.signerStateToken === undefined) {
			pending.replacementsBeforeToken.push({ signerStateToken, error })
			return
		}
		if (doSignerStateTokensMatch(pending.signerStateToken, signerStateToken)) pending.future.resolve({ type: 'replacement', error })
	})
	pendingSignerChainChange = pending
	try {
		const dispatchedToken = sendCallbackToConfirmedSignerOwner(websiteTabConnections, requestTabId, { method: 'request_signer_to_wallet_switchEthereumChain', result: rpcNetwork.chainId, walletSwitchRequestId: pending.walletSwitchRequestId })
		if (dispatchedToken === false) return { error: signerUnavailableError }
		await sendPopupMessageToOpenWindows({ method: 'popup_settingsUpdated', data: await getSettings(), popupRefreshGeneration: bumpPopupRefreshGeneration() })
		pending.signerStateToken = dispatchedToken
		if (!pending.receivedReplyTokens.some(token => doSignerStateTokensMatch(dispatchedToken, token))) pending.timeout = setTimeout(() => {
			pending.future.resolve({ type: 'timeout' })
		}, timeoutMs)
		const precedingReply = pending.repliesBeforeToken.find(({ signerStateToken, confirmation }) => {
			return doSignerStateTokensMatch(dispatchedToken, signerStateToken)
				&& confirmation.data[0].chainId === pending.requestedRpcNetwork.chainId
		})
		if (precedingReply !== undefined) pending.future.resolve({ type: 'reply', confirmation: precedingReply.confirmation })
		const precedingReplacement = pending.replacementsBeforeToken.find(({ signerStateToken }) => doSignerStateTokensMatch(dispatchedToken, signerStateToken))
		if (precedingReplacement !== undefined) pending.future.resolve({ type: 'replacement', error: precedingReplacement.error })
		const signerResult = await pending.future
		if (signerResult.type === 'timeout') return { error: { code: -32002, message: 'Your wallet did not answer the network request in time. You can retry or change other settings. Your wallet may still show the previous request.' } }
		if (signerResult.type === 'replacement') return { error: signerResult.error } as const
		if (signerResult.confirmation.data[0].accept === false) return { error: signerResult.confirmation.data[0].error } as const // forward signers error to the application
		if (signerResult.confirmation.data[0].chainId === rpcNetwork.chainId) return { result: null }
	} finally {
		clearTimeout(pending.timeout)
		removeReplacementListener()
		if (pendingSignerChainChange === pending) pendingSignerChainChange = undefined
	}
	return { error: { code: METAMASK_ERROR_USER_REJECTED_REQUEST, message: 'User denied the chain change.' } }
}

function rejectWalletSwitchReply(token: SignerStateToken, params: WalletSwitchEthereumChainReply['params'][0], error: { readonly code: number, readonly message: string }) {
	resolveSignerChainChange(token, {
		method: 'popup_signerChangeChainDialog',
		data: [{ ...params, accept: false, error }],
	})
}

// Own reply matching, deadline cancellation and settlement together, including failures while applying wallet state.
export async function applyWalletSwitchReply(
	websiteTabConnections: WebsiteTabConnections,
	port: browser.runtime.Port,
	params: WalletSwitchEthereumChainReply['params'][0],
	applyChain: (token: SignerStateToken, chainId: bigint, rpc: RpcNetwork | undefined) => Promise<void>,
) {
	const socket = getSocketFromPort(port)
	if (socket === undefined) return
	await runSignerStateOperation(websiteTabConnections, socket.tabId, async () => {
		const currentSignerStateToken = getConfirmedSignerStateToken(websiteTabConnections, socket.tabId)
		if (currentSignerStateToken?.socket.connectionName !== socket.connectionName || currentSignerStateToken.port !== port) return
		if (!isPendingWalletSwitchRequest(params.walletSwitchRequestId)) return
		const pendingSignerStateToken = getPendingSignerChainChangeTokenForCallback(port, params.signerProviderGeneration, params.chainId)
		const callbackSignerStateToken = pendingSignerStateToken
			?? (currentSignerStateToken.signerProviderGeneration === params.signerProviderGeneration ? currentSignerStateToken : undefined)
		if (callbackSignerStateToken === undefined) return
		const solicitedReply = isPendingSignerChainChangeReply(callbackSignerStateToken, params.chainId)
		// Only this command's owner and chain may apply its reply. Unsolicited chain events use signerChainChanged.
		if (!solicitedReply) return
		if (currentSignerStateToken.signerProviderGeneration !== params.signerProviderGeneration) {
			rejectWalletSwitchReply(callbackSignerStateToken, params, signerConnectionReplacedError)
			return
		}
		markSignerChainReplyReceived(callbackSignerStateToken, params.chainId, params.walletSwitchRequestId)
		try {
			if (params.accept) {
				const requestedRpc = getPendingSignerChainChangeRpc(callbackSignerStateToken, params.chainId)
				await applyChain(currentSignerStateToken, params.chainId, requestedRpc)
				const activeRpc = (await getSettings()).activeRpcNetwork
				if (requestedRpc !== undefined && getRpcNetworkChange(activeRpc, requestedRpc).endpointChanged) {
					rejectWalletSwitchReply(callbackSignerStateToken, params, { code: JSON_RPC_ERROR_CODE_INTERNAL_ERROR, message: 'The wallet switched networks, but Interceptor could not activate the requested network.' })
					return
				}
				if (requestedRpc !== undefined) await promoteRpcAsPrimary(requestedRpc)
			}
			resolveSignerChainChange(callbackSignerStateToken, {
				method: 'popup_signerChangeChainDialog',
				data: [params],
			})
		} catch (error) {
			// Delivery ended the wallet deadline; a failure while applying the reply must also release the waiting popup.
			rejectWalletSwitchReply(callbackSignerStateToken, params, { code: JSON_RPC_ERROR_CODE_INTERNAL_ERROR, message: 'The wallet replied, but updating the selected network failed. Refresh the popup and try again.' })
			throw error
		}
		return
	})
}
