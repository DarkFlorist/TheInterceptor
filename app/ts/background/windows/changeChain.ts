import { METAMASK_ERROR_USER_REJECTED_REQUEST } from '../../utils/constants.js'
import { Future } from '../../utils/future.js'
import type { ChainChangeConfirmation, SignerChainChangeConfirmation } from '../../types/interceptor-messages.js'
import type { WebsiteTabConnections } from '../../types/user-interface-types.js'
import { changeActiveRpc } from '../activeSettings.js'
import { getHtmlFile, sendPopupMessageToOpenWindows } from '../backgroundUtils.js'
import { getChainChangeConfirmationPromise, getRpcNetworkForChain, setChainChangeConfirmationPromise } from '../storageVariables.js'
import type { RpcNetwork } from '../../types/rpc.js'
import { type InterceptedRequest, type UniqueRequestIdentifier, doesUniqueRequestIdentifiersMatch } from '../../utils/requests.js'
import { replyToInterceptedRequest } from '../messageSending.js'
import type { SwitchEthereumChainParams } from '../../types/JsonRpc-types.js'
import type { PopupOrTabId, Website } from '../../types/websiteAccessTypes.js'
import type { EthereumClientService } from '../../simulation/services/EthereumClientService.js'
import type { TokenPriceService } from '../../simulation/services/priceEstimator.js'
import type { ResetSimulationServices } from '../../simulation/serviceLifecycle.js'
import { type PopupOrTab, addWindowTabListeners, closePopupOrTabById, getPopupOrTabById, openPopupOrTab, removeWindowTabListeners } from '../../utils/popupOrTab.js'
import { addSignerStateReplacementListener, doSignerStateTokensMatch, getConfirmedSignerStateToken, signerUnavailableError, type SignerStateToken } from '../signerStateOwnership.js'

let pendForUserReply: Future<ChainChangeConfirmation> | undefined 

type PendingSignerChainChange = {
	readonly future: Future<
		| { readonly type: 'reply', readonly confirmation: SignerChainChangeConfirmation }
		| { readonly type: 'replacement', readonly error: typeof signerUnavailableError }
		| { readonly type: 'timeout' }
	>
	timeout: ReturnType<typeof setTimeout> | undefined
	readonly requestTabId: number
	readonly requestedRpcNetwork: RpcNetwork
	signerStateToken: SignerStateToken | undefined
	readonly repliesBeforeToken: Array<{ readonly signerStateToken: SignerStateToken, readonly confirmation: SignerChainChangeConfirmation }>
	readonly replacementsBeforeToken: Array<{ readonly signerStateToken: SignerStateToken, readonly error: typeof signerUnavailableError }>
}

let pendingSignerChainChange: PendingSignerChainChange | undefined
// The wallet protocol has no per-command identifier. Keep timed-out commands isolated until their reply or a new signer generation, so a late reply cannot complete a retry.
const expiredSignerChainChanges = new WeakMap<browser.runtime.Port, { readonly token: SignerStateToken, readonly chainId: bigint }>()
const WALLET_SWITCH_TIMEOUT_MS = 120_000

export function consumeExpiredSignerChainReply(port: browser.runtime.Port, signerProviderGeneration: number, chainId: bigint) {
	const expired = expiredSignerChainChanges.get(port)
	if (expired === undefined || expired.token.signerProviderGeneration !== signerProviderGeneration || expired.chainId !== chainId) return false
	expiredSignerChainChanges.delete(port)
	return true
}

export function markSignerChainReplyReceived(token: SignerStateToken, chainId: bigint) {
	const pending = pendingSignerChainChange
	if (pending !== undefined && doesPendingSignerChainChangeMatch(pending, token, chainId)) clearTimeout(pending.timeout)
}

let chainChangeResolutionInProgress = false

let openedDialog: PopupOrTab | undefined 

export async function updateChainChangeViewWithPendingRequest() {
	const promise = await getChainChangeConfirmationPromise()
	if (promise) await sendPopupMessageToOpenWindows({ method: 'popup_ChangeChainRequest', data: promise })
	return
}

export async function resolveChainChange(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, resetSimulationServices: ResetSimulationServices, websiteTabConnections: WebsiteTabConnections, confirmation: ChainChangeConfirmation) {
	if (pendForUserReply !== undefined) {
		pendForUserReply.resolve(confirmation)
		return
	}
	await runExclusiveChainChangeResolution(async () => {
		const data = await getChainChangeConfirmationPromise()
		if (data === undefined || !doesUniqueRequestIdentifiersMatch(confirmation.data.uniqueRequestIdentifier, data.request.uniqueRequestIdentifier)) throw new Error('Unique request identifier mismatch in change chain')
		const resolved = await resolve(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, confirmation, data.simulationMode)
		if (resolved.error !== undefined) {
			replyToInterceptedRequest(websiteTabConnections, { type: 'result', method: 'wallet_switchEthereumChain' as const, error: resolved.error, uniqueRequestIdentifier: data.request.uniqueRequestIdentifier })
		} else {
			replyToInterceptedRequest(websiteTabConnections, { type: 'result', method: 'wallet_switchEthereumChain' as const, result: resolved.result, uniqueRequestIdentifier: data.request.uniqueRequestIdentifier })
		}
		if (openedDialog) await closePopupOrTabById(openedDialog)
		openedDialog = undefined
	})
}

async function runExclusiveChainChangeResolution<T>(resolution: () => Promise<T>) {
	if (chainChangeResolutionInProgress) return undefined
	chainChangeResolutionInProgress = true
	try {
		return await resolution()
	} finally {
		chainChangeResolutionInProgress = false
	}
}

function doesPendingSignerChainChangeMatch(pending: PendingSignerChainChange, signerStateToken: SignerStateToken, chainId: bigint) {
	if (pending.requestedRpcNetwork.chainId !== chainId) return false
	return pending.signerStateToken === undefined
		? pending.requestTabId === signerStateToken.socket.tabId
		: doSignerStateTokensMatch(pending.signerStateToken, signerStateToken)
}

export function getPendingSignerChainChangeTokenForCallback(port: browser.runtime.Port, signerProviderGeneration: number, chainId: bigint) {
	const signerStateToken = pendingSignerChainChange?.signerStateToken
	if (signerStateToken === undefined || pendingSignerChainChange?.requestedRpcNetwork.chainId !== chainId) return undefined
	if (signerStateToken.port !== port || signerStateToken.signerProviderGeneration !== signerProviderGeneration) return undefined
	return signerStateToken
}

export function isPendingSignerChainChangeReply(signerStateToken: SignerStateToken, chainId: bigint) {
	return pendingSignerChainChange !== undefined && doesPendingSignerChainChangeMatch(pendingSignerChainChange, signerStateToken, chainId)
}

// Keep the requested endpoint in memory until the matching wallet accepts; a rejected request must not change RPC preferences.
export function getPendingSignerChainChangeRpc(signerStateToken: SignerStateToken, chainId: bigint) {
	const pending = pendingSignerChainChange
	return pending !== undefined && doesPendingSignerChainChangeMatch(pending, signerStateToken, chainId) ? pending.requestedRpcNetwork : undefined
}

export function resolveSignerChainChange(signerStateToken: SignerStateToken, confirmation: SignerChainChangeConfirmation) {
	if (consumeExpiredSignerChainReply(signerStateToken.port, signerStateToken.signerProviderGeneration, confirmation.data[0].chainId)) return false
	markSignerChainReplyReceived(signerStateToken, confirmation.data[0].chainId)
	const pending = pendingSignerChainChange
	if (pending === undefined || !doesPendingSignerChainChangeMatch(pending, signerStateToken, confirmation.data[0].chainId)) return false
	if (pending.signerStateToken === undefined) {
		pending.repliesBeforeToken.push({ signerStateToken, confirmation })
		return true
	}
	pending.future.resolve({ type: 'reply', confirmation })
	return true
}

function rejectMessage(rpcNetwork: RpcNetwork, uniqueRequestIdentifier: UniqueRequestIdentifier) {
	return {
		method: 'popup_changeChainDialog',
		data: {
			rpcNetwork,
			uniqueRequestIdentifier,
			accept: false,
		},
	} as const
}

const userDeniedChange = {
	error: {
		code: METAMASK_ERROR_USER_REJECTED_REQUEST,
		message: 'User denied the chain change.',
	}
} as const

export const openChangeChainDialog = async (
	ethereum: EthereumClientService,
	tokenPriceService: TokenPriceService,
	resetSimulationServices: ResetSimulationServices,
	websiteTabConnections: WebsiteTabConnections,
	request: InterceptedRequest,
	simulationMode: boolean,
	website: Website,
	params: SwitchEthereumChainParams,
) => {
	if (openedDialog !== undefined || pendForUserReply || pendingSignerChainChange || chainChangeResolutionInProgress) return userDeniedChange

	pendForUserReply = new Future<ChainChangeConfirmation>()

	const onCloseWindowOrTab = async (popupOrTab: PopupOrTabId) => { // check if user has closed the window on their own, if so, reject signature
		if (openedDialog === undefined || openedDialog.id !== popupOrTab.id || openedDialog.type !== popupOrTab.type) return
		openedDialog = undefined
		if (pendForUserReply === undefined) return
		resolveChainChange(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, rejectMessage(await getRpcNetworkForChain(params.params[0].chainId), request.uniqueRequestIdentifier))
	}
	const onCloseWindow = async (id: number) => onCloseWindowOrTab({ type: 'popup' as const, id })
	const onCloseTab = async (id: number) => onCloseWindowOrTab({ type: 'tab' as const, id })

	try {
		const oldPromise = await getChainChangeConfirmationPromise()
		if (oldPromise !== undefined) {
			if (await getPopupOrTabById(oldPromise.popupOrTabId) !== undefined) return userDeniedChange
			await setChainChangeConfirmationPromise(undefined)
		}
		openedDialog = await openPopupOrTab({
			url: getHtmlFile('changeChain'),
			type: 'popup',
			height: 800,
			width: 600,
		})

		if (openedDialog !== undefined) {
			addWindowTabListeners(onCloseWindow, onCloseTab)
			await setChainChangeConfirmationPromise({
				website: website,
				popupOrTabId: openedDialog,
				request: request,
				simulationMode: simulationMode,
				rpcNetwork: await getRpcNetworkForChain(params.params[0].chainId),
			})
			await updateChainChangeViewWithPendingRequest()
		} else {
			await resolveChainChange(
				ethereum,
				tokenPriceService,
				resetSimulationServices,
				websiteTabConnections,
				rejectMessage(await getRpcNetworkForChain(params.params[0].chainId), request.uniqueRequestIdentifier),
			)
		}
		const reply = await pendForUserReply

		// forward message to content script
		const resolution = runExclusiveChainChangeResolution(async () => await resolve(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, reply, simulationMode))
		return resolution.then((result) => result ?? userDeniedChange)
	} finally {
		removeWindowTabListeners(onCloseWindow, onCloseTab)
		pendForUserReply = undefined
		if (openedDialog) await closePopupOrTabById(openedDialog)
		openedDialog = undefined
	}
}

async function resolve(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, resetSimulationServices: ResetSimulationServices, websiteTabConnections: WebsiteTabConnections, reply: ChainChangeConfirmation, simulationMode: boolean) {
	await setChainChangeConfirmationPromise(undefined)
	if (reply.data.accept) {
		if (simulationMode) {
			await changeActiveRpc(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, reply.data.rpcNetwork, simulationMode, reply.data.uniqueRequestIdentifier.requestSocket.tabId)
			return { result: null }
		}
		return await requestSignerChainChange(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, reply.data.rpcNetwork, reply.data.uniqueRequestIdentifier.requestSocket.tabId)
	}
	return userDeniedChange
}

export async function requestSignerChainChange(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, resetSimulationServices: ResetSimulationServices, websiteTabConnections: WebsiteTabConnections, rpcNetwork: RpcNetwork, requestTabId: number, timeoutMs = WALLET_SWITCH_TIMEOUT_MS) {
	if (pendingSignerChainChange !== undefined) return { error: { code: -32002, message: 'A network switch is already waiting for your wallet.' } }
	const currentToken = getConfirmedSignerStateToken(websiteTabConnections, requestTabId)
	const expired = currentToken === undefined ? undefined : expiredSignerChainChanges.get(currentToken.port)
	if (expired !== undefined && currentToken !== undefined && expired.token.signerProviderGeneration === currentToken.signerProviderGeneration) return { error: { code: -32002, message: 'The previous network request is still open in your wallet. Dismiss it or reconnect the wallet before trying again.' } }
	const pending: PendingSignerChainChange = {
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
		const changeActiveRpcResult = await changeActiveRpc(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, rpcNetwork, false, requestTabId)
		if (changeActiveRpcResult.type !== 'signerRequestSent') {
			return changeActiveRpcResult.type === 'signerRequestNotNeeded'
				? { result: null } as const
				: { error: signerUnavailableError } as const
		}
		pending.signerStateToken = changeActiveRpcResult.signerStateToken
		pending.timeout = setTimeout(() => {
			expiredSignerChainChanges.set(changeActiveRpcResult.signerStateToken.port, { token: changeActiveRpcResult.signerStateToken, chainId: rpcNetwork.chainId })
			pending.future.resolve({ type: 'timeout' })
		}, timeoutMs)
		const precedingReply = pending.repliesBeforeToken.find(({ signerStateToken, confirmation }) => {
			return doSignerStateTokensMatch(changeActiveRpcResult.signerStateToken, signerStateToken)
				&& confirmation.data[0].chainId === pending.requestedRpcNetwork.chainId
		})
		if (precedingReply !== undefined) pending.future.resolve({ type: 'reply', confirmation: precedingReply.confirmation })
		const precedingReplacement = pending.replacementsBeforeToken.find(({ signerStateToken }) => doSignerStateTokensMatch(changeActiveRpcResult.signerStateToken, signerStateToken))
		if (precedingReplacement !== undefined) pending.future.resolve({ type: 'replacement', error: precedingReplacement.error })
		const signerResult = await pending.future
		if (signerResult.type === 'timeout') return { error: { code: -32002, message: 'Your wallet did not answer the network request in time. Other settings are available again. Dismiss the request in your wallet or reconnect it before retrying.' } }
		if (signerResult.type === 'replacement') return { error: signerResult.error } as const
		if (signerResult.confirmation.data[0].accept === false) return { error: signerResult.confirmation.data[0].error } as const // forward signers error to the application
		if (signerResult.confirmation.data[0].chainId === rpcNetwork.chainId) return { result: null }
	} finally {
		clearTimeout(pending.timeout)
		removeReplacementListener()
		if (pendingSignerChainChange === pending) pendingSignerChainChange = undefined
	}
	return userDeniedChange
}
