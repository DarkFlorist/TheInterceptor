import { ConnectedToSigner, SignerReply, WalletSwitchEthereumChainReply } from '../types/interceptor-messages.js'
import type { TabState, WebsiteTabConnections } from '../types/user-interface-types.js'
import { EthereumAccountsReply, EthereumChainReply } from '../types/JsonRpc-types.js'
import { changeActiveAddressAndChain } from './background.js'
import { getSocketFromPort, sendInternalWindowMessage, sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { getRpcNetworkForChain, setDefaultSignerName, updatePendingTransactionOrMessage, updateTabState } from './storageVariables.js'
import { getMetamaskCompatibilityMode, getSettings } from './settings.js'
import { getPendingSignerChainChangeTokenForCallback, isPendingSignerChainChangeReply, resolveSignerChainChange } from './windows/changeChain.js'
import { type ApprovalState, withSuppressedUnscopedConnectionEventsForSocketAsync } from './accessManagement.js'
import type { ProviderMessage } from '../utils/requests.js'
import { METAMASK_ERROR_USER_REJECTED_REQUEST } from '../utils/constants.js'
import { reportUnexpectedError } from '../utils/errors.js'
import { resolvePendingTransactionOrMessage, updateConfirmTransactionView } from './windows/confirmTransaction.js'
import { modifyObject } from '../utils/typescript.js'
import { sendSubscriptionReplyOrCallBackToPort } from './messageSending.js'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { TokenPriceService } from '../simulation/services/priceEstimator.js'
import type { ResetSimulationServices } from '../simulation/serviceLifecycle.js'
import { isSignerMissing } from '../utils/signerMetadata.js'
import { beginSignerStateConfirmation, clearSignerDerivedTabState, confirmSignerState, getConfirmedSignerStateToken, isCurrentWebsiteConnection, isSignerStateTokenCurrent, runSignerStateOperation, signerConnectionReplacedError, tabHasApprovedWebsiteConnection, type SignerStateToken } from './signerStateOwnership.js'

const SIGNER_PROTOCOL_VERSION = 1
const INPAGE_PROTOCOL_CONFIRMATION_TIMEOUT_MS = 250
type InpageProtocolState = {
	status: 'negotiating' | 'confirming' | 'compatible' | 'incompatible'
	readonly confirmation: Promise<void>
	readonly confirm: () => void
}
const inpageProtocolStates = new WeakMap<browser.runtime.Port, InpageProtocolState>()
const incompatibleInpageProtocolNotifiedPorts = new WeakSet<browser.runtime.Port>()

export function initializeInpageProtocolNegotiation(port: browser.runtime.Port) {
	const existingState = inpageProtocolStates.get(port)
	if (existingState !== undefined) return
	let confirm: () => void = () => undefined
	const confirmation = new Promise<void>((resolve) => { confirm = resolve })
	inpageProtocolStates.set(port, { status: 'negotiating', confirmation, confirm })
}

function beginInpageProtocolConfirmation(port: browser.runtime.Port) {
	initializeInpageProtocolNegotiation(port)
	const state = inpageProtocolStates.get(port)
	if (state === undefined || state.status === 'incompatible') return false
	if (state.status === 'compatible') return true
	state.status = 'confirming'
	return true
}

function confirmInpageProtocol(port: browser.runtime.Port) {
	const existingState = inpageProtocolStates.get(port)
	if (existingState === undefined) {
		inpageProtocolStates.set(port, { status: 'compatible', confirmation: Promise.resolve(), confirm: () => undefined })
		return
	}
	if (existingState.status === 'incompatible') return
	existingState.status = 'compatible'
	existingState.confirm()
}

export async function hasCompatibleInpageProtocol(port: browser.runtime.Port) {
	const state = inpageProtocolStates.get(port)
	if (state === undefined || state.status === 'compatible') return true
	if (state.status === 'incompatible') return false
	let timeout: ReturnType<typeof setTimeout> | undefined
	const confirmationTimeout = new Promise<void>((resolve) => {
		timeout = setTimeout(resolve, INPAGE_PROTOCOL_CONFIRMATION_TIMEOUT_MS)
	})
	try {
		await Promise.race([state.confirmation, confirmationTimeout])
	} finally {
		if (timeout !== undefined) clearTimeout(timeout)
	}
	let resolvedState = inpageProtocolStates.get(port)
	if (resolvedState?.status === 'confirming') {
		await resolvedState.confirmation
		resolvedState = inpageProtocolStates.get(port)
	}
	if (resolvedState?.status === 'compatible') return true
	if (resolvedState === undefined) return true
	resolvedState.status = 'incompatible'
	resolvedState.confirm()
	return false
}

export function notifyIncompatibleInpageProtocol(port: browser.runtime.Port) {
	if (incompatibleInpageProtocolNotifiedPorts.has(port)) return
	incompatibleInpageProtocolNotifiedPorts.add(port)
	sendSubscriptionReplyOrCallBackToPort(port, { type: 'result', method: 'disconnect', result: [] })
}

function getSignerCallbackToken(websiteTabConnections: WebsiteTabConnections, port: browser.runtime.Port, signerProviderGeneration: number) {
	const socket = getSocketFromPort(port)
	if (socket === undefined) return undefined
	const token = getConfirmedSignerStateToken(websiteTabConnections, socket.tabId)
	if (token === undefined) return undefined
	if (token.socket.connectionName !== socket.connectionName || token.port !== port) return undefined
	if (token.signerProviderGeneration !== signerProviderGeneration) return undefined
	return token
}

async function getConnectedToSignerResult(): Promise<{
	readonly type: 'result'
	readonly method: 'connected_to_signer'
	readonly result: {
		readonly metamaskCompatibilityMode: boolean
		readonly signerProtocolVersion: 1
	}
}> {
	return {
		type: 'result' as const,
		method: 'connected_to_signer' as const,
		result: {
			metamaskCompatibilityMode: await getMetamaskCompatibilityMode(),
			signerProtocolVersion: SIGNER_PROTOCOL_VERSION,
		},
	}
}

function hasSignerCallbackAccess(websiteTabConnections: WebsiteTabConnections, tabId: number, approval: ApprovalState) {
	return approval === 'hasAccess' || tabHasApprovedWebsiteConnection(websiteTabConnections, tabId)
}

export async function ethAccountsReply(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, resetSimulationServices: ResetSimulationServices, websiteTabConnections: WebsiteTabConnections, port: browser.runtime.Port, request: ProviderMessage, approval: ApprovalState, _activeAddress: bigint | undefined) {
	const returnValue = { type: 'result' as const, method: 'eth_accounts_reply' as const, result: '0x' as const }
	if (!('params' in request)) return returnValue
	if (port.sender?.tab?.id === undefined) return returnValue
	const tabId = port.sender.tab.id
	if (!hasSignerCallbackAccess(websiteTabConnections, tabId, approval)) return returnValue

	const [signerAccountsReply] = EthereumAccountsReply.parse(request.params)
	return await runSignerStateOperation(websiteTabConnections, tabId, async () => {
		const signerStateToken = getSignerCallbackToken(websiteTabConnections, port, signerAccountsReply.signerProviderGeneration)
		if (signerStateToken === undefined) return returnValue
		if (signerAccountsReply.type === 'error') {
			const stringifiedData = signerAccountsReply.error.data ? JSON.stringify(signerAccountsReply.error.data) : undefined
			const error = signerAccountsReply.error
			const signerAccountError = {
				code: error.code,
				message: error.message,
				...(stringifiedData !== undefined ? { data: stringifiedData } : {}),
			}
			// Signer discovery reports local absence through this request-scoped error so account requests can settle.
			// The connected_to_signer message owns the persistent NoSigner state; only actual wallet errors belong in the popup.
			if (signerAccountsReply.signerUnavailable !== true) {
				await updateTabState(tabId, (previousState: TabState) => modifyObject(previousState, { signerAccountError }))
			}
			if (!isSignerStateTokenCurrent(websiteTabConnections, signerStateToken)) return returnValue
			// Wake requesters waiting for a signer accounts round-trip even when the signer rejected or errored.
			sendInternalWindowMessage({
				method: 'window_signer_accounts_changed',
				data: {
					socket: signerStateToken.socket,
					signerStateOwnerGeneration: signerStateToken.ownerGeneration,
					signerProviderGeneration: signerStateToken.signerProviderGeneration,
					error: signerAccountError,
				},
			})
			await sendPopupMessageToOpenWindows({ method: 'popup_accounts_update' })
			return returnValue
		}
		const signerAccounts = signerAccountsReply.accounts
		const activeSigningAddress = signerAccounts.length > 0 ? signerAccounts[0] : undefined
		const tabStateChange = await updateTabState(tabId, (previousState: TabState) => modifyObject(previousState, {
			...signerAccounts.length > 0 ? { signerAccountError: undefined } : {},
			signerAccounts,
			activeSigningAddress,
		}))
		if (!isSignerStateTokenCurrent(websiteTabConnections, signerStateToken)) return returnValue
		await sendPopupMessageToOpenWindows({ method: 'popup_activeSigningAddressChanged', data: { tabId, activeSigningAddress } })
		sendInternalWindowMessage({
			method: 'window_signer_accounts_changed',
			data: {
				socket: signerStateToken.socket,
				signerStateOwnerGeneration: signerStateToken.ownerGeneration,
				signerProviderGeneration: signerStateToken.signerProviderGeneration,
			},
		})
		// Update the active address if we are using the signer's address. This remains inside the signer-state
		// operation so a reconnect cannot interleave with the downstream address and chain mutations.
		const settings = await getSettings()
		if ((settings.useSignersAddressAsActiveAddress && settings.activeSimulationAddress !== signerAccounts[0])
		|| (settings.simulationMode === false && tabStateChange.previousState.activeSigningAddress !== tabStateChange.newState.activeSigningAddress)) {
			const changeActiveAddress = async () => await changeActiveAddressAndChain(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, {
				simulationMode: settings.simulationMode,
				activeAddress: tabStateChange.newState.activeSigningAddress,
			})
			if (signerAccountsReply.requestAccounts) {
				await withSuppressedUnscopedConnectionEventsForSocketAsync(signerStateToken.socket, changeActiveAddress)
			} else {
				await changeActiveAddress()
			}
			await sendPopupMessageToOpenWindows({ method: 'popup_accounts_update' })
		}
		return returnValue
	})
}

async function changeSignerChain(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, resetSimulationServices: ResetSimulationServices, websiteTabConnections: WebsiteTabConnections, signerStateToken: SignerStateToken, signerChain: bigint, approval: ApprovalState, _activeAddress: bigint | undefined) {
	if (approval !== 'hasAccess') return
	const tabStateChange = await updateTabState(signerStateToken.socket.tabId, (previousState: TabState) => {
		return previousState.signerChain === signerChain ? previousState : modifyObject(previousState, { signerChain })
	})
	if (!isSignerStateTokenCurrent(websiteTabConnections, signerStateToken)) return
	const oldSignerChain = tabStateChange.previousState.signerChain
	// update active address if we are using signers address
	const settings = await getSettings()
	if ((settings.useSignersAddressAsActiveAddress || !settings.simulationMode) && settings.activeRpcNetwork.chainId !== signerChain) {
		const rpcNetwork = await getRpcNetworkForChain(signerChain)
		return changeActiveAddressAndChain(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, {
			simulationMode: settings.simulationMode,
			rpcNetwork,
		})
	}
	if (oldSignerChain !== signerChain) sendPopupMessageToOpenWindows({ method: 'popup_chain_update' })
}

export async function signerChainChanged(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, resetSimulationServices: ResetSimulationServices, websiteTabConnections: WebsiteTabConnections, port: browser.runtime.Port, request: ProviderMessage, approval: ApprovalState, activeAddress: bigint | undefined) {
	const returnValue = { type: 'result' as const, method: 'signer_chainChanged' as const, result: '0x' as const }
	if (!('params' in request)) return returnValue
	const [signerChain, signerProviderGeneration] = EthereumChainReply.parse(request.params)
	const socket = getSocketFromPort(port)
	if (socket === undefined) return returnValue
	if (!hasSignerCallbackAccess(websiteTabConnections, socket.tabId, approval)) return returnValue
	return await runSignerStateOperation(websiteTabConnections, socket.tabId, async () => {
		const signerStateToken = getSignerCallbackToken(websiteTabConnections, port, signerProviderGeneration)
		if (signerStateToken === undefined) return returnValue
		await changeSignerChain(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, signerStateToken, signerChain, 'hasAccess', activeAddress)
		return returnValue
	})
}

export async function walletSwitchEthereumChainReply(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, resetSimulationServices: ResetSimulationServices, websiteTabConnections: WebsiteTabConnections, port: browser.runtime.Port, request: ProviderMessage, approval: ApprovalState, activeAddress: bigint | undefined) {
	const returnValue = { type: 'result' as const, method: 'wallet_switchEthereumChain_reply' as const, result: '0x' as const }
	const params = WalletSwitchEthereumChainReply.parse(request).params[0]
	const socket = getSocketFromPort(port)
	if (socket === undefined) return returnValue
	return await runSignerStateOperation(websiteTabConnections, socket.tabId, async () => {
		const currentSignerStateToken = getConfirmedSignerStateToken(websiteTabConnections, socket.tabId)
		if (currentSignerStateToken?.socket.connectionName !== socket.connectionName || currentSignerStateToken.port !== port) return returnValue
		const pendingSignerStateToken = getPendingSignerChainChangeTokenForCallback(port, params.signerProviderGeneration, params.chainId)
		const callbackSignerStateToken = pendingSignerStateToken
			?? (currentSignerStateToken.signerProviderGeneration === params.signerProviderGeneration ? currentSignerStateToken : undefined)
		if (callbackSignerStateToken === undefined) return returnValue
		const solicitedReply = isPendingSignerChainChangeReply(callbackSignerStateToken, params.chainId)
		// A solicited wallet reply retains the tab authorization captured when its command was dispatched.
		// Unsolicited chainChanged-style updates still require a currently approved frame.
		if (!solicitedReply && !hasSignerCallbackAccess(websiteTabConnections, socket.tabId, approval)) return returnValue
		if (currentSignerStateToken.signerProviderGeneration !== params.signerProviderGeneration) {
			resolveSignerChainChange(callbackSignerStateToken, {
				method: 'popup_signerChangeChainDialog',
				data: [{ accept: false, chainId: params.chainId, error: signerConnectionReplacedError, signerProviderGeneration: params.signerProviderGeneration }],
			})
			return returnValue
		}
		if (params.accept) await changeSignerChain(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, currentSignerStateToken, params.chainId, 'hasAccess', activeAddress)
		resolveSignerChainChange(callbackSignerStateToken, {
			method: 'popup_signerChangeChainDialog',
			data: [params],
		})
		return returnValue
	})
}

export async function connectedToSigner(_ethereum: EthereumClientService, _tokenPriceService: TokenPriceService, _resetSimulationServices: ResetSimulationServices, websiteTabConnections: WebsiteTabConnections, port: browser.runtime.Port, request: ProviderMessage, approval: ApprovalState, _activeAddress: bigint | undefined) {
	const connectedToSigner = ConnectedToSigner.parse(request)
	if (connectedToSigner.params.length === 2) {
		// The former two-field message is understood only well enough to identify an injected
		// script from an incompatible extension version. It must never mutate signer state.
		initializeInpageProtocolNegotiation(port)
		return await getConnectedToSignerResult()
	}
	if (!beginInpageProtocolConfirmation(port)) return await getConnectedToSignerResult()
	try {
		const [signerConnected, signerName, signerProviderGeneration] = connectedToSigner.params
		// MV2 and test ports may omit frameId. Treat those as the top frame, while preventing an
		// unapproved MV3 child frame from taking ownership of tab-wide signer state.
		const isTopFrame = port.sender?.frameId === undefined || port.sender.frameId === 0
		let result: Awaited<ReturnType<typeof getConnectedToSignerResult>>
		if (approval !== 'hasAccess' && !isTopFrame) {
			result = await getConnectedToSignerResult()
		} else {
			const socket = getSocketFromPort(port)
			const requestSocket = request.uniqueRequestIdentifier.requestSocket
			if (socket === undefined || socket.tabId !== requestSocket.tabId || socket.connectionName !== requestSocket.connectionName) {
				result = await getConnectedToSignerResult()
			} else {
				result = await runSignerStateOperation(websiteTabConnections, socket.tabId, async () => {
					const tabConnection = websiteTabConnections.get(socket.tabId)
					if (!isCurrentWebsiteConnection(tabConnection, socket, port) || tabConnection?.signerStateOwner?.connectionName !== socket.connectionName) {
						return await getConnectedToSignerResult()
					}
					const previousSignerProviderGeneration = tabConnection.signerStateOwner.providerGeneration
					if (tabConnection.signerStateOwner.confirmed
						&& previousSignerProviderGeneration !== undefined
						&& signerProviderGeneration < previousSignerProviderGeneration) {
						return await getConnectedToSignerResult()
					}
					const signerStateWasConfirmed = tabConnection.signerStateOwner.confirmed
					beginSignerStateConfirmation(tabConnection)
					const signerMissing = isSignerMissing(signerName)
					await updateTabState(socket.tabId, (previousState: TabState) => {
						const signerIdentityChanged = previousState.signerName !== signerName
						const clearSignerState = !signerStateWasConfirmed
							|| previousSignerProviderGeneration !== signerProviderGeneration
							|| signerIdentityChanged
							|| signerMissing
							|| !signerConnected
						const baseState = clearSignerState ? clearSignerDerivedTabState(previousState) : previousState
						return modifyObject(baseState, { signerName, signerConnected: signerMissing ? false : signerConnected })
					})
					if (!isCurrentWebsiteConnection(tabConnection, socket, port) || tabConnection.signerStateOwner.connectionName !== socket.connectionName) {
						return await getConnectedToSignerResult()
					}
					confirmSignerState(tabConnection, signerProviderGeneration)
					await setDefaultSignerName(signerName)
					await sendPopupMessageToOpenWindows({ method: 'popup_signer_name_changed' })
					if (hasSignerCallbackAccess(websiteTabConnections, socket.tabId, approval)) {
						const settings = await getSettings()
						if (!signerMissing && (!settings.simulationMode || settings.useSignersAddressAsActiveAddress)) {
							sendSubscriptionReplyOrCallBackToPort(port, { type: 'result', method: 'request_signer_chainId', result: [] })
						}
					}
					return await getConnectedToSignerResult()
				})
			}
		}
		return result
	} finally {
		confirmInpageProtocol(port)
	}
}

export async function signerReply(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, _resetSimulationServices: ResetSimulationServices, websiteTabConnections: WebsiteTabConnections, port: browser.runtime.Port, request: ProviderMessage, _approval: ApprovalState, _activeAddress: bigint | undefined) {
	const signerReply = SignerReply.parse(request)
	const params = signerReply.params[0]
	const doNotReply = { type: 'doNotReply' as const }
	const socket = getSocketFromPort(port)
	if (socket === undefined) return doNotReply
	return await runSignerStateOperation(websiteTabConnections, socket.tabId, async () => {
		const requestSocket = request.uniqueRequestIdentifier.requestSocket
		const uniqueRequestIdentifier = { requestId: params.forwardRequest.requestId, requestSocket }
		const tabConnection = websiteTabConnections.get(socket.tabId)
		const currentSignerStateToken = getConfirmedSignerStateToken(websiteTabConnections, socket.tabId)
		const signerProviderGenerationChanged = currentSignerStateToken?.signerProviderGeneration !== params.signerProviderGeneration
		// Signing is routed back through the frame that originated the request, which may be a child frame.
		// The request remains scoped by its request id and exact child-frame port, while the provider generation
		// belongs to the tab-wide signer owner.
		if (!isCurrentWebsiteConnection(tabConnection, socket, port)
			|| requestSocket.tabId !== socket.tabId
			|| requestSocket.connectionName !== socket.connectionName
			|| signerProviderGenerationChanged) {
			await updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (transaction) => modifyObject(transaction, { approvalStatus: { status: 'SignerError', ...signerConnectionReplacedError } }))
			await updateConfirmTransactionView(ethereum, tokenPriceService)
			return doNotReply
		}
		switch(params.forwardRequest.method) {
			case 'personal_sign':
			case 'eth_signTypedData':
			case 'eth_signTypedData_v1':
			case 'eth_signTypedData_v2':
			case 'eth_signTypedData_v3':
			case 'eth_signTypedData_v4':
			case 'eth_sendRawTransaction':
			case 'eth_sendTransaction': {
				if (params.success) {
					try {
						await resolvePendingTransactionOrMessage(ethereum, tokenPriceService, websiteTabConnections, {
							method: 'popup_confirmDialog',
							data: {
								uniqueRequestIdentifier,
								action: 'signerIncluded',
								signerReply: params.reply,
							}
						})
					} catch(e) {
						await reportUnexpectedError(e)
					}
					return doNotReply
				}
				if (params.error.code === METAMASK_ERROR_USER_REJECTED_REQUEST) {
					await updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (transaction) => modifyObject(transaction, { approvalStatus: { status: 'WaitingForUser' } }))
					await updateConfirmTransactionView(ethereum, tokenPriceService)
					return doNotReply
				}
				await updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (transaction) => modifyObject(transaction, { approvalStatus: { status: 'SignerError', ...params.error } }))
				await updateConfirmTransactionView(ethereum, tokenPriceService)
				return doNotReply
			}
		}
		if (params.success) return { type: 'result' as const, method: 'signer_reply' as const, result: params.reply }
		return { type: 'result' as const, method: 'signer_reply' as const, error: params.error }
	})
}
