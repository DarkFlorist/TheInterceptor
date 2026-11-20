import { prepareSafeAppsRequest } from './safeAppsRequestHandler.js'
import type { RpcRequestContext } from '../types/confirmationRequest.js'
import type { InpageScriptRequest, RPCReply, Settings } from '../types/interceptor-messages.js'
import 'webextension-polyfill'
import { getTabState, getUserAddressBookEntriesForChainIdMorePreciseFirst } from './storageVariables.js'
import { getSettings, getWebsiteAccess, updateWebsiteAccess } from './settings.js'
import { stringifyJSONWithBigInts } from '../utils/bigint.js'
import { blockNumber, call, chainId, estimateGas, gasPrice, getAccounts, getBalance, getBlockByNumber, getBlockByHash, getCode, getFilterChanges, getFilterLogs, getLogs, getPermissions, getStorageAt, getTransactionByHash, getTransactionCount, getTransactionReceipt, handleInterceptorError, installNewFilter, maxPriorityFeePerGas, netVersion, personalSign, requestInterceptorSimulatorStack, requestPermissions, sendTransaction, subscribe, switchEthereumChain, ethSimulateV1, feeHistory, uninstallNewFilter, unsubscribe, web3ClientVersion } from './simulationModeHandlers.js'
import { PASSTHROUGH_STATE, type ResolvedExecutionSimulationState, type ResolvedSimulationInput, toResolvedExecutionSimulationState, toResolvedSimulationInput } from '../types/visualizer-types.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { askForSignerAccountsFromSignerIfNotAvailable, requestAccessFromUser, type ReplayInterceptedRequest } from './windows/interceptorAccess.js'
import { METAMASK_ERROR_FAILED_TO_PARSE_REQUEST, METAMASK_ERROR_NOT_CONNECTED_TO_CHAIN, METAMASK_ERROR_PROVIDER_DISCONNECTED, METAMASK_ERROR_USER_REJECTED_REQUEST, ERROR_INTERCEPTOR_DISABLED } from '../utils/constants.js'
import { clearWebsiteConnectionIntent, refuseAccess, sendAccountsChangedToPort, verifyAccess, withSuppressedUnscopedConnectionEventsForSocket } from './accessManagement.js'
import { finalizeWebsiteAccessChange, persistWebsiteAccessChange } from './websiteAccessReconciliation.js'
import { getActiveAddressEntryForChain, getWalletActiveAddressEntryForChain } from './metadataUtils.js'
import { getActiveAddress } from './backgroundUtils.js'
import { assertNever, hasOwnKey } from '../utils/typescript.js'
import { JsonRpcResponseError, reportUnexpectedError, isFailedToFetchError } from '../utils/errors.js'
import { InterceptedRequest, type WebsiteSocket } from '../utils/requests.js'
import { replyToInterceptedRequest } from './messageSending.js'
import { EthereumJsonRpcRequest, type EthGetStorageAtParams, type SendRawTransactionParams, type SendTransactionParams, SupportedEthereumJsonRpcRequestMethods, type WalletAddEthereumChain, WalletRevokePermissions } from '../types/JsonRpc-types.js'
import type { Website } from '../types/websiteAccessTypes.js'
import { serialize } from '../types/wire-types.js'
import { connectedToSigner, ethAccountsReply, signerChainChanged, signerReply, walletSwitchEthereumChainReply } from './providerMessageHandlers.js'
import { makeSureInterceptorIsNotSleeping } from './sleeping.js'
import type { PublishRpcConnectionStatus } from './rpcSlowRequestTracking.js'
import { buildExecutionSimulationStateFromPreparedInput, getCurrentSimulationInput, getUpdatedSimulationStackSnapshot, prepareSimulationInputForRpc } from './simulationUpdating.js'
import type { SimulationServicesOwner } from '../simulation/serviceLifecycle.js'
import { getWalletSelectedAccount, isActiveSigningSafe } from '../utils/activeAddressSelection.js'
import { isAccountConnectionMethod, isAccountOnlyMethod } from './accountRequestMethods.js'
import type { ErrorWithCodeAndOptionalData } from '../types/error.js'
import type { AddressBookEntry } from '../types/addressBookTypes.js'
import { getActiveAddressForCurrentSignerState, getConfirmedSignerStateToken, isSignerStateTokenCurrent } from './signerStateOwnership.js'
import { handleWatchAssetRequest, initializeWatchAssetWindowListeners, processWatchAssetQueue } from './windows/watchAsset.js'
import { getSafeModeRpcPolicyReply } from '../safe/safeRequestPolicy.js'
import { getWatchAssetRpcParseFailureReply } from './watchAssetRpc.js'
import { createMethodHandlerFor } from '../utils/methodHandlers.js'
import { getWalletCapabilities } from './walletCapabilities.js'
import { getWalletGetCapabilitiesParseFailureReply } from './walletGetCapabilitiesRpc.js'
import { hasAccess as getWebsiteAccessApprovalState, hasAddressAccess as getWebsiteAddressAccessApprovalState } from './websiteAccessPolicy.js'

if (initializeWatchAssetWindowListeners()) {
	void processWatchAssetQueue(undefined).catch(async (error: unknown) => {
		await reportUnexpectedError(error, { code: 'watch_asset_startup_recovery_failed' })
	})
}

const RPC_PARSE_FAILURE_HANDLERS = [getWatchAssetRpcParseFailureReply, getWalletGetCapabilitiesParseFailureReply]
const JSON_RPC_METHOD_NOT_FOUND = -32601
const INTERNAL_PROVIDER_METHODS = [
	'connected_to_signer',
	'eth_accounts_reply',
	'InterceptorError',
	'safe_apps_request',
	'signer_chainChanged',
	'signer_reply',
	'wallet_switchEthereumChain_reply',
] as const

const isInternalProviderMethod = (method: string) => INTERNAL_PROVIDER_METHODS.some((internalMethod) => internalMethod === method)

async function handleRPCRequest(
	simulationServicesOwner: SimulationServicesOwner,
	websiteTabConnections: WebsiteTabConnections,
	socket: WebsiteSocket,
	website: Website,
	context: RpcRequestContext,
	settings: Settings,
	activeAddress: bigint | undefined,
	publishRpcConnectionStatus: PublishRpcConnectionStatus,
	simulationOverlayEnabled: boolean,
	safeSigningMode: boolean,
	activeSafeSigner: bigint | undefined,
): Promise<RPCReply> {
	// Select one execution pair after admission; lazy simulation preparation uses this same pair.
	const { ethereum, tokenPriceService } = simulationServicesOwner.getCurrent()
	let simulationInputPromise: Promise<ResolvedSimulationInput> | undefined
	let executionSimulationStatePromise: Promise<ResolvedExecutionSimulationState> | undefined
	const getSimulationInput = async () => {
		if (!simulationOverlayEnabled) return PASSTHROUGH_STATE
		if (simulationInputPromise === undefined) simulationInputPromise = (async () => toResolvedSimulationInput(await prepareSimulationInputForRpc(await getCurrentSimulationInput(), ethereum)))()
		return await simulationInputPromise
	}
	const getExecutionSimulationState = async () => {
		if (!simulationOverlayEnabled) return PASSTHROUGH_STATE
		if (executionSimulationStatePromise === undefined) executionSimulationStatePromise = (async () => {
			const simulationInput = await getSimulationInput()
			if (simulationInput.kind === 'passthrough') return PASSTHROUGH_STATE
			return toResolvedExecutionSimulationState(await buildExecutionSimulationStateFromPreparedInput(simulationInput.value, ethereum))
		})()
		return await executionSimulationStatePromise
	}
	const { request, confirmation } = context
	const maybeParsedRequest = confirmation === undefined
		? EthereumJsonRpcRequest.safeParse(request)
		: { success: true as const, value: confirmation.parameters }
	const forwardToSigner = !settings.simulationMode && !request.usingInterceptorWithoutSigner
	const getForwardingMessage = (request: SendRawTransactionParams | SendTransactionParams | WalletAddEthereumChain | EthGetStorageAtParams) => {
		if (!forwardToSigner) throw new Error('Should not forward to signer')
		return { type: 'forwardToSigner' as const, ...request }
	}

	if (maybeParsedRequest.success === false) {
		for (const getMethodSpecificReply of RPC_PARSE_FAILURE_HANDLERS) {
			const methodSpecificReply = getMethodSpecificReply(request)
			if (methodSpecificReply !== undefined) return methodSpecificReply
		}
		const safePolicyReply = getSafeModeRpcPolicyReply({
			rawRequest: request,
			confirmation,
			parsedRequest: undefined,
			safeSigningMode,
			forwardToSigner,
			activeAddress,
			chainId: settings.activeRpcNetwork.chainId,
			hasRpcConnection: settings.activeRpcNetwork.httpsRpc !== undefined,
		})
		if (safePolicyReply !== undefined) return safePolicyReply
		console.warn({ request })
		console.warn(maybeParsedRequest.fullError)
		const maybePartiallyParsedRequest = SupportedEthereumJsonRpcRequestMethods.safeParse(request)
		// the method is some method that we are not supporting, forward it to the wallet if signer is available
		if (maybePartiallyParsedRequest.success === false && forwardToSigner) return { type: 'forwardToSigner' as const, replyWithSignersReply: true, ...request }
		return {
			type: 'result' as const,
			method: request.method,
			error: {
				message: `Failed to parse RPC request: ${ JSON.stringify(serialize(InterceptedRequest, request)) }`,
				code: METAMASK_ERROR_FAILED_TO_PARSE_REQUEST,
			}
		}
	}
	const parsedRequest = maybeParsedRequest.value
	const safePolicyReply = getSafeModeRpcPolicyReply({
		rawRequest: request,
		confirmation,
		parsedRequest,
		safeSigningMode,
		forwardToSigner,
		activeAddress,
		chainId: settings.activeRpcNetwork.chainId,
		hasRpcConnection: settings.activeRpcNetwork.httpsRpc !== undefined,
	})
	if (safePolicyReply !== undefined) return safePolicyReply
	const accountOnlyMethod = isAccountOnlyMethod(parsedRequest.method)
	if (settings.activeRpcNetwork.httpsRpc === undefined && forwardToSigner && !accountOnlyMethod) {
		// we are using network that is not supported by us
		return { type: 'forwardToSigner' as const, replyWithSignersReply: true, ...request }
	}
	const withSimulationInput = async (handler: (simulationInput: ResolvedSimulationInput) => Promise<RPCReply>) => await handler(await getSimulationInput())
	const withExecutionSimulationState = async (handler: (simulationState: ResolvedExecutionSimulationState) => Promise<RPCReply>) => await handler(await getExecutionSimulationState())
	if (!accountOnlyMethod) await makeSureInterceptorIsNotSleeping(ethereum, publishRpcConnectionStatus)
	type ParsedRpcRequest = typeof parsedRequest
	type RpcRequestHandler = (context: undefined, request: ParsedRpcRequest) => Promise<RPCReply>
	const rpcRequestHandler = createMethodHandlerFor<ParsedRpcRequest, undefined, Promise<RPCReply>>()
	const signMessage = async (signRequest: Extract<ParsedRpcRequest, { readonly method: 'personal_sign' | 'eth_signTypedData' | 'eth_signTypedData_v1' | 'eth_signTypedData_v2' | 'eth_signTypedData_v3' | 'eth_signTypedData_v4' }>) => await personalSign(ethereum, tokenPriceService, activeAddress, confirmation?.kind === 'message' ? confirmation : { kind: 'message', parameters: signRequest }, request, website, websiteTabConnections, !forwardToSigner)
	const sendEthereumTransaction = async (transactionRequest: Extract<ParsedRpcRequest, { readonly method: 'eth_sendRawTransaction' | 'eth_sendTransaction' }>) => {
		if (forwardToSigner && settings.activeRpcNetwork.httpsRpc === undefined) return getForwardingMessage(transactionRequest)
		return await sendTransaction(ethereum, tokenPriceService, activeAddress, confirmation?.kind === 'transaction' ? confirmation : { kind: 'transaction', parameters: transactionRequest }, request, website, websiteTabConnections, !forwardToSigner)
	}
	const rpcRequestHandlers = {
		eth_getBlockByHash: rpcRequestHandler('eth_getBlockByHash', async (_context, rpcRequest) => await withSimulationInput((simulationInput) => getBlockByHash(ethereum, simulationInput, rpcRequest))),
		eth_getBlockByNumber: rpcRequestHandler('eth_getBlockByNumber', async (_context, rpcRequest) => await withSimulationInput((simulationInput) => getBlockByNumber(ethereum, simulationInput, rpcRequest))),
		eth_getBalance: rpcRequestHandler('eth_getBalance', async (_context, rpcRequest) => await withSimulationInput((simulationInput) => getBalance(ethereum, simulationInput, rpcRequest))),
		eth_estimateGas: rpcRequestHandler('eth_estimateGas', async (_context, rpcRequest) => await withSimulationInput((simulationInput) => estimateGas(ethereum, simulationInput, rpcRequest))),
		eth_getTransactionByHash: rpcRequestHandler('eth_getTransactionByHash', async (_context, rpcRequest) => await withSimulationInput((simulationInput) => getTransactionByHash(ethereum, simulationInput, rpcRequest))),
		eth_getTransactionReceipt: rpcRequestHandler('eth_getTransactionReceipt', async (_context, rpcRequest) => await withExecutionSimulationState((simulationState) => getTransactionReceipt(ethereum, simulationState, rpcRequest))),
		eth_call: rpcRequestHandler('eth_call', async (_context, rpcRequest) => await withSimulationInput((simulationInput) => call(ethereum, simulationInput, rpcRequest))),
		eth_blockNumber: rpcRequestHandler('eth_blockNumber', async () => await withSimulationInput((simulationInput) => blockNumber(ethereum, simulationInput))),
		eth_subscribe: rpcRequestHandler('eth_subscribe', async (_context, rpcRequest) => await subscribe(socket, rpcRequest)),
		eth_unsubscribe: rpcRequestHandler('eth_unsubscribe', async (_context, rpcRequest) => await unsubscribe(socket, rpcRequest)),
		eth_chainId: rpcRequestHandler('eth_chainId', async () => await chainId(ethereum)),
		net_version: rpcRequestHandler('net_version', async () => await netVersion(ethereum)),
		eth_getCode: rpcRequestHandler('eth_getCode', async (_context, rpcRequest) => await withSimulationInput((simulationInput) => getCode(ethereum, simulationInput, rpcRequest))),
		personal_sign: rpcRequestHandler('personal_sign', async (_context, rpcRequest) => await signMessage(rpcRequest)),
		eth_signTypedData: rpcRequestHandler('eth_signTypedData', async (_context, rpcRequest) => await signMessage(rpcRequest)),
		eth_signTypedData_v1: rpcRequestHandler('eth_signTypedData_v1', async (_context, rpcRequest) => await signMessage(rpcRequest)),
		eth_signTypedData_v2: rpcRequestHandler('eth_signTypedData_v2', async (_context, rpcRequest) => await signMessage(rpcRequest)),
		eth_signTypedData_v3: rpcRequestHandler('eth_signTypedData_v3', async (_context, rpcRequest) => await signMessage(rpcRequest)),
		eth_signTypedData_v4: rpcRequestHandler('eth_signTypedData_v4', async (_context, rpcRequest) => await signMessage(rpcRequest)),
		wallet_switchEthereumChain: rpcRequestHandler('wallet_switchEthereumChain', async (_context, rpcRequest) => await switchEthereumChain(simulationServicesOwner, websiteTabConnections, rpcRequest, request, settings.simulationMode, website)),
		wallet_watchAsset: rpcRequestHandler('wallet_watchAsset', async (_context, rpcRequest) => await handleWatchAssetRequest(ethereum, websiteTabConnections, request, website, rpcRequest, {}, activeAddress)),
		wallet_requestPermissions: rpcRequestHandler('wallet_requestPermissions', async () => await requestPermissions(activeAddress, website)),
		wallet_getPermissions: rpcRequestHandler('wallet_getPermissions', async () => await getPermissions(activeAddress, website)),
		wallet_getCapabilities: rpcRequestHandler('wallet_getCapabilities', async (_context, rpcRequest) => {
			if (rpcRequest.params[0] !== activeAddress) {
				return getWalletCapabilities(rpcRequest, activeAddress, settings.activeRpcNetwork.chainId, activeSafeSigner)
			}
			if (!safeSigningMode && activeSafeSigner === undefined && forwardToSigner) {
				return { type: 'forwardToSigner', replyWithSignersReply: true, ...request }
			}
			return getWalletCapabilities(rpcRequest, activeAddress, settings.activeRpcNetwork.chainId, activeSafeSigner)
		}),
		eth_accounts: rpcRequestHandler('eth_accounts', async () => await getAccounts(activeAddress)),
		eth_requestAccounts: rpcRequestHandler('eth_requestAccounts', async () => await getAccounts(activeAddress)),
		eth_gasPrice: rpcRequestHandler('eth_gasPrice', async () => await gasPrice(ethereum)),
		eth_getTransactionCount: rpcRequestHandler('eth_getTransactionCount', async (_context, rpcRequest) => await withSimulationInput((simulationInput) => getTransactionCount(ethereum, simulationInput, rpcRequest))),
		interceptor_getSimulationStack: rpcRequestHandler('interceptor_getSimulationStack', async (_context, rpcRequest) => await requestInterceptorSimulatorStack(await getUpdatedSimulationStackSnapshot(ethereum, simulationOverlayEnabled), simulationOverlayEnabled, websiteTabConnections, rpcRequest, website, request, socket)),
		eth_simulateV1: rpcRequestHandler('eth_simulateV1', async (_context, rpcRequest) => await withSimulationInput((simulationInput) => ethSimulateV1(ethereum, simulationInput, rpcRequest))),
		wallet_addEthereumChain: rpcRequestHandler('wallet_addEthereumChain', async (_context, rpcRequest) => {
			if (forwardToSigner) return getForwardingMessage(rpcRequest)
			return { type: 'result' as const, method: rpcRequest.method, error: { code: 10000, message: 'wallet_addEthereumChain not implemented' } }
		}),
		eth_getStorageAt: rpcRequestHandler('eth_getStorageAt', async (_context, rpcRequest) => {
			if (forwardToSigner && !simulationOverlayEnabled) return { ...getForwardingMessage(rpcRequest), replyWithSignersReply: true as const }
			return await withSimulationInput((simulationInput) => getStorageAt(ethereum, simulationInput, rpcRequest))
		}),
		eth_getLogs: rpcRequestHandler('eth_getLogs', async (_context, rpcRequest) => await withExecutionSimulationState((simulationState) => getLogs(ethereum, simulationState, rpcRequest))),
		eth_sign: rpcRequestHandler('eth_sign', async (_context, rpcRequest) => ({ type: 'result' as const, method: rpcRequest.method, error: { code: 10000, message: 'eth_sign is deprecated' } })),
		eth_sendRawTransaction: rpcRequestHandler('eth_sendRawTransaction', async (_context, rpcRequest) => await sendEthereumTransaction(rpcRequest)),
		eth_sendTransaction: rpcRequestHandler('eth_sendTransaction', async (_context, rpcRequest) => await sendEthereumTransaction(rpcRequest)),
		web3_clientVersion: rpcRequestHandler('web3_clientVersion', async () => await web3ClientVersion(ethereum)),
		eth_feeHistory: rpcRequestHandler('eth_feeHistory', async (_context, rpcRequest) => await feeHistory(ethereum, rpcRequest)),
		eth_maxPriorityFeePerGas: rpcRequestHandler('eth_maxPriorityFeePerGas', async () => await maxPriorityFeePerGas(ethereum)),
		eth_newFilter: rpcRequestHandler('eth_newFilter', async (_context, rpcRequest) => await withSimulationInput((simulationInput) => installNewFilter(socket, rpcRequest, ethereum, simulationInput))),
		eth_uninstallFilter: rpcRequestHandler('eth_uninstallFilter', async (_context, rpcRequest) => await uninstallNewFilter(socket, rpcRequest)),
		eth_getFilterChanges: rpcRequestHandler('eth_getFilterChanges', async (_context, rpcRequest) => await withExecutionSimulationState((simulationState) => getFilterChanges(socket, rpcRequest, ethereum, simulationState))),
		eth_getFilterLogs: rpcRequestHandler('eth_getFilterLogs', async (_context, rpcRequest) => await withExecutionSimulationState((simulationState) => getFilterLogs(socket, rpcRequest, ethereum, simulationState))),
		InterceptorError: rpcRequestHandler('InterceptorError', async (_context, rpcRequest) => await handleInterceptorError(rpcRequest)),
	} as const satisfies Record<ParsedRpcRequest['method'], RpcRequestHandler>
	return await rpcRequestHandlers[parsedRequest.method](undefined, parsedRequest)
}

const providerHandlers = {
	signer_reply: { method: 'signer_reply' as const, func: signerReply },
	eth_accounts_reply: { method: 'eth_accounts_reply' as const, func: ethAccountsReply },
	signer_chainChanged: { method: 'signer_chainChanged' as const, func: signerChainChanged },
	wallet_switchEthereumChain_reply: { method: 'wallet_switchEthereumChain_reply' as const, func: walletSwitchEthereumChainReply },
	connected_to_signer: { method: 'connected_to_signer' as const, func: connectedToSigner },
}

function isProviderMethod(method: string): method is keyof typeof providerHandlers {
	return hasOwnKey(providerHandlers, method)
}

function getProviderHandler(method: string) {
	if (!isProviderMethod(method)) return { method: 'notProviderMethod' as const }
	return providerHandlers[method]
}

function replyWithEmptyAccounts(websiteTabConnections: WebsiteTabConnections, request: InterceptedRequest) {
	return replyToInterceptedRequest(websiteTabConnections, { type: 'result', method: 'eth_accounts' as const, result: [], uniqueRequestIdentifier: request.uniqueRequestIdentifier })
}

function replyWithEmptyPermissions(websiteTabConnections: WebsiteTabConnections, request: InterceptedRequest) {
	return replyToInterceptedRequest(websiteTabConnections, { type: 'result', method: 'wallet_getPermissions' as const, result: [], uniqueRequestIdentifier: request.uniqueRequestIdentifier })
}

function replyWithoutActiveAccount(websiteTabConnections: WebsiteTabConnections, request: InterceptedRequest) {
	switch (request.method) {
		case 'eth_accounts': return replyWithEmptyAccounts(websiteTabConnections, request)
		case 'wallet_getPermissions': return replyWithEmptyPermissions(websiteTabConnections, request)
		case 'wallet_getCapabilities': return refuseAccess(websiteTabConnections, request)
		default: throw new Error(`Unsupported account identity request method: ${ request.method }`)
	}
}

function getRequestWithDefinedParams(request: InterceptedRequest) {
	return 'params' in request && request.params !== undefined ? { ...request, params: request.params } : request
}

function refusePublicInternalProviderMethod(websiteTabConnections: WebsiteTabConnections, request: InterceptedRequest) {
	return replyToInterceptedRequest(websiteTabConnections, {
		type: 'result',
		method: request.method,
		uniqueRequestIdentifier: request.uniqueRequestIdentifier,
		error: {
			code: JSON_RPC_METHOD_NOT_FOUND,
			message: `Method not found: ${ request.method }`,
		},
	})
}

function getAccountRequestResultAccounts(resolved: RPCReply) {
	if (resolved.type !== 'result') return undefined
	if (!('result' in resolved)) return undefined
	if (!Array.isArray(resolved.result)) return undefined
	if (!resolved.result.every((account) => typeof account === 'bigint')) return undefined
	return resolved.result
}

function getApprovedAccountsForAccountRequest(request: InterceptedRequest, resolved: RPCReply, activeAddress: bigint | undefined) {
	if (!isAccountConnectionMethod(request.method)) return undefined
	if (request.method === 'wallet_requestPermissions' && resolved.type === 'result' && 'result' in resolved) return activeAddress === undefined ? [] : [activeAddress]
	return getAccountRequestResultAccounts(resolved)
}

function replayProviderStateForAccountRequest(websiteTabConnections: WebsiteTabConnections, request: InterceptedRequest, resolved: RPCReply, activeAddress: bigint | undefined) {
	const accounts = getApprovedAccountsForAccountRequest(request, resolved, activeAddress)
	if (accounts === undefined || accounts.length === 0) return
	sendAccountsChangedToPort(websiteTabConnections, request.uniqueRequestIdentifier.requestSocket, accounts, request.uniqueRequestIdentifier.requestId)
}

async function persistApprovedAccountsForAccountRequest(
	websiteTabConnections: WebsiteTabConnections,
	request: InterceptedRequest,
	website: Website,
	requestSettings: Settings,
	resolved: RPCReply,
	activeAddress: bigint | undefined,
): Promise<void> {
	const accounts = getApprovedAccountsForAccountRequest(request, resolved, activeAddress)
	if (accounts === undefined || accounts.length === 0) return

	// Entries come from the chain the request ran on; approvals are re-read so a grant stored while the request ran is not written twice.
	const websiteAccess = await getWebsiteAccess()
	for (const account of accounts) {
		const addressEntry = await getActiveAddressEntryForChain(account, requestSettings.activeRpcNetwork.chainId)
		const existingApprovalState = getWebsiteAddressAccessApprovalState(websiteAccess, website.websiteOrigin, addressEntry)
		if (addressEntry.askForAddressAccess === false) continue
		if (existingApprovalState === 'hasAccess') continue
		await persistWebsiteAccessChange(
			websiteTabConnections,
			website,
			true,
			account,
			false,
		)
	}
}

async function revokeWebsitePermissions(
	websiteTabConnections: WebsiteTabConnections,
	websiteOrigin: string,
) {
	await updateWebsiteAccess((previousAccess) => previousAccess.map((access) => {
		if (access.website.websiteOrigin !== websiteOrigin) return access
		const { access: previousPermission, addressAccess: _removedAddressAccess, ...remainingAccess } = access
		return {
			...remainingAccess,
			addressAccess: undefined,
			...previousPermission === false ? { access: false } : {},
		}
	}))
	clearWebsiteConnectionIntent(websiteTabConnections, websiteOrigin)
	await finalizeWebsiteAccessChange(websiteTabConnections, false)
	return { type: 'result' as const, method: 'wallet_revokePermissions' as const, result: null }
}

function parseWalletRevokePermissionsRequest(websiteTabConnections: WebsiteTabConnections, request: InterceptedRequest) {
	const maybeParsedRequest = WalletRevokePermissions.safeParse(request)
	if (maybeParsedRequest.success) return maybeParsedRequest.value
	replyToInterceptedRequest(websiteTabConnections, {
		type: 'result',
		method: request.method,
		uniqueRequestIdentifier: request.uniqueRequestIdentifier,
		error: {
			message: `Failed to parse RPC request: ${ JSON.stringify(serialize(InterceptedRequest, request)) }`,
			code: METAMASK_ERROR_FAILED_TO_PARSE_REQUEST,
		},
	})
	return undefined
}

async function getActiveAddressForRequest(settings: Settings, websiteTabConnections: WebsiteTabConnections, tabId: number) {
	return await getActiveAddressForCurrentSignerState(websiteTabConnections, settings, tabId, async () => await getActiveAddress(settings, tabId))
}

// Resolves a request's active address entry from settings. A context keeps the resolver that produced its address, so a request that waited reads the same entry again rather than another entry for the same address.
type ReadActiveAddress = (settings: Settings) => Promise<AddressBookEntry | undefined>

// One settings snapshot and the active address derived from it. A request's access is decided and the request executed on the same context; it is re-read only after waiting on the signer wallet, whose reply can change both, and access is decided again if what decided it changes while the website metadata loads (see executeOnceWebsiteLoads).
type InterceptedRequestContext = {
	readonly settings: Settings
	readonly activeAddress: AddressBookEntry | undefined
	readonly readActiveAddress: ReadActiveAddress
}

async function readInterceptedRequestContext(websiteTabConnections: WebsiteTabConnections, tabId: number): Promise<InterceptedRequestContext> {
	const readActiveAddress: ReadActiveAddress = async (settings) => await getActiveAddressForRequest(settings, websiteTabConnections, tabId)
	const settings = await getSettings()
	return { settings, activeAddress: await readActiveAddress(settings), readActiveAddress }
}

// The wallet entry of the signer's first account; Safes are left out, as they are for any wallet-selected address.
const getFirstSignerAddress = async (firstSignerAccount: bigint, settings: Settings) => await getWalletActiveAddressEntryForChain(firstSignerAccount, settings.activeRpcNetwork.chainId)

// Resolves the first signer account the tab has now, so a request that waited follows a wallet account switch. The account came from the signer, so it only counts while the signer's state is confirmed, in every mode; otherwise nothing resolves and the request decides again.
const readCurrentFirstSignerAddress = (websiteTabConnections: WebsiteTabConnections, tabId: number): ReadActiveAddress => async (settings) => {
	const signerStateToken = getConfirmedSignerStateToken(websiteTabConnections, tabId)
	if (signerStateToken === undefined) return undefined
	const firstSignerAccount = (await getTabState(tabId)).signerAccounts[0]
	const firstSignerAddress = firstSignerAccount === undefined ? undefined : await getFirstSignerAddress(firstSignerAccount, settings)
	return isSignerStateTokenCurrent(websiteTabConnections, signerStateToken) ? firstSignerAddress : undefined
}

async function discoverAccountRequestAddressContext(
	websiteTabConnections: WebsiteTabConnections,
	socket: WebsiteSocket,
	request: InterceptedRequest,
	websiteOrigin: string,
	initialContext: InterceptedRequestContext,
) {
	const withoutSignerRequest = { requestContext: initialContext, requestedSignerAccountsForAddressConsent: false, signerAccountError: undefined }
	if (initialContext.activeAddress !== undefined) return withoutSignerRequest
	if (!isAccountConnectionMethod(request.method)) return withoutSignerRequest
	const websiteAccess = getWebsiteAccessApprovalState(initialContext.settings.websiteAccess, websiteOrigin)
	if (websiteAccess === 'noAccess' || websiteAccess === 'interceptorDisabled') return withoutSignerRequest

	const signerAccountsResult = await askForSignerAccountsFromSignerIfNotAvailable(websiteTabConnections, socket, true)
	const refreshedContext = await readInterceptedRequestContext(websiteTabConnections, socket.tabId)
	if (refreshedContext.activeAddress !== undefined) return { requestContext: refreshedContext, requestedSignerAccountsForAddressConsent: true, signerAccountError: signerAccountsResult.error }
	const firstSignerAccount = signerAccountsResult.accounts[0]
	if (firstSignerAccount === undefined) return { requestContext: refreshedContext, requestedSignerAccountsForAddressConsent: true, signerAccountError: signerAccountsResult.error }
	return { requestContext: { settings: refreshedContext.settings, activeAddress: await getFirstSignerAddress(firstSignerAccount, refreshedContext.settings), readActiveAddress: readCurrentFirstSignerAddress(websiteTabConnections, socket.tabId) }, requestedSignerAccountsForAddressConsent: true, signerAccountError: signerAccountsResult.error }
}

const isSignerProviderDisconnectedError = (error: ErrorWithCodeAndOptionalData | undefined): error is ErrorWithCodeAndOptionalData => error?.code === METAMASK_ERROR_PROVIDER_DISCONNECTED
const isSignerAccountAccessRejectedError = (error: ErrorWithCodeAndOptionalData | undefined): error is ErrorWithCodeAndOptionalData => error?.code === METAMASK_ERROR_USER_REJECTED_REQUEST
const isTerminalSignerAccountConnectionError = (error: ErrorWithCodeAndOptionalData | undefined): error is ErrorWithCodeAndOptionalData => {
	return isSignerProviderDisconnectedError(error) || isSignerAccountAccessRejectedError(error)
}

function replyWithSignerAccountError(websiteTabConnections: WebsiteTabConnections, request: InterceptedRequest, error: ErrorWithCodeAndOptionalData) {
	// Injected-wallet connection UIs commonly treat 4001 as the only terminal account-access failure. Keep the more precise 4900 internally, but expose unavailable page-level wallet access as a rejected interactive connection.
	const publicError = isAccountConnectionMethod(request.method) && isSignerProviderDisconnectedError(error)
		? { ...error, code: METAMASK_ERROR_USER_REJECTED_REQUEST }
		: error
	return replyToInterceptedRequest(websiteTabConnections, {
		type: 'result',
		...getRequestWithDefinedParams(request),
		error: publicError,
	})
}

export const handleInterceptedRequest = async (port: browser.runtime.Port | undefined, websiteOrigin: string, websitePromise: Promise<Website> | Website, simulationServicesOwner: SimulationServicesOwner, socket: WebsiteSocket, request: InterceptedRequest, websiteTabConnections: WebsiteTabConnections, publishRpcConnectionStatus: PublishRpcConnectionStatus): Promise<unknown> => {
	if (request.method === 'wallet_revokePermissions') {
		const parsedRequest = parseWalletRevokePermissionsRequest(websiteTabConnections, request)
		if (parsedRequest === undefined) return
		const result = await revokeWebsitePermissions(websiteTabConnections, websiteOrigin)
		return replyToInterceptedRequest(websiteTabConnections, { ...getRequestWithDefinedParams(request), ...result })
	}
	const initialContext = await readInterceptedRequestContext(websiteTabConnections, socket.tabId)
	if (request.interceptorInternalRequest !== true && isInternalProviderMethod(request.method)) return refusePublicInternalProviderMethod(websiteTabConnections, request)
	const providerHandler = getProviderHandler(request.method)
	const identifiedMethod = providerHandler.method
	if (identifiedMethod !== 'notProviderMethod') {
		if (port === undefined) return
		const providerCallbackApproval = request.method === 'eth_accounts_reply'
			? 'hasAccess'
			: getWebsiteAccessApprovalState(initialContext.settings.websiteAccess, websiteOrigin)
		const providerCallbackActiveAddress = initialContext.activeAddress !== undefined && getWebsiteAddressAccessApprovalState(initialContext.settings.websiteAccess, websiteOrigin, initialContext.activeAddress) === 'hasAccess'
			? initialContext.activeAddress.address
			: undefined
		const providerHandlerReturn = await providerHandler.func(simulationServicesOwner, websiteTabConnections, port, request, providerCallbackApproval, providerCallbackActiveAddress)
		if (providerHandlerReturn.type === 'doNotReply') return
		const message: InpageScriptRequest = { uniqueRequestIdentifier: request.uniqueRequestIdentifier, ...providerHandlerReturn }
		return replyToInterceptedRequest(websiteTabConnections, message)
	}
	const { requestContext, requestedSignerAccountsForAddressConsent, signerAccountError } = await discoverAccountRequestAddressContext(websiteTabConnections, socket, request, websiteOrigin, initialContext)
	const { settings, activeAddress } = requestContext
	if (isTerminalSignerAccountConnectionError(signerAccountError)) return replyWithSignerAccountError(websiteTabConnections, request, signerAccountError)
	if (requestedSignerAccountsForAddressConsent && activeAddress === undefined) {
		if (getWebsiteAccessApprovalState(settings.websiteAccess, websiteOrigin) === 'interceptorDisabled') return replyToInterceptedRequest(websiteTabConnections, { type: 'result', ...getRequestWithDefinedParams(request), ...ERROR_INTERCEPTOR_DISABLED })
		return refuseAccess(websiteTabConnections, request)
	}
	const accountConnectionRequest = isAccountConnectionMethod(request.method)
	const accountIdentityRequest = isAccountOnlyMethod(request.method)
	const verifyRequestAccess = () => verifyAccess(
		websiteTabConnections,
		socket,
		accountConnectionRequest || request.method === 'eth_call' || request.method === 'eth_simulateV1',
		websiteOrigin,
		activeAddress,
		settings,
		{
			ignoreConnectionApproval: accountIdentityRequest,
		},
	)
	const access = accountConnectionRequest ? withSuppressedUnscopedConnectionEventsForSocket(socket, verifyRequestAccess) : verifyRequestAccess()
	if (access === 'interceptorDisabled') return replyToInterceptedRequest(websiteTabConnections, { type: 'result', ...getRequestWithDefinedParams(request), ...ERROR_INTERCEPTOR_DISABLED })
	if (access === 'hasAccess' && activeAddress === undefined && accountConnectionRequest) {
		// user has granted access to the site, but not to this account and the application is requesting accounts
		if (requestedSignerAccountsForAddressConsent) return refuseAccess(websiteTabConnections, request)
		const signerAccountsResult = await askForSignerAccountsFromSignerIfNotAvailable(websiteTabConnections, socket, true)
		if (isTerminalSignerAccountConnectionError(signerAccountsResult.error)) return replyWithSignerAccountError(websiteTabConnections, request, signerAccountsResult.error)
		if (signerAccountsResult.accounts.length === 0) return refuseAccess(websiteTabConnections, request)
		const result: unknown = await handleInterceptedRequest(port, websiteOrigin, websitePromise, simulationServicesOwner, socket, request, websiteTabConnections, publishRpcConnectionStatus)
		return result
	}
	if (access === 'hasAccess' && activeAddress === undefined && (request.method === 'eth_accounts' || request.method === 'wallet_getPermissions' || request.method === 'wallet_getCapabilities') && (!settings.simulationMode || settings.useSignersAddressAsActiveAddress)) {
		const signerAccountsResult = await askForSignerAccountsFromSignerIfNotAvailable(websiteTabConnections, socket, false)
		if (isSignerProviderDisconnectedError(signerAccountsResult.error)) {
			if (request.method === 'wallet_getCapabilities') return replyWithoutActiveAccount(websiteTabConnections, request)
			return replyWithSignerAccountError(websiteTabConnections, request, signerAccountsResult.error)
		}
		const signerAccounts = signerAccountsResult.accounts
		if (signerAccounts.length === 0) return replyWithoutActiveAccount(websiteTabConnections, request)
		const firstSignerAccount = signerAccounts[0]
		if (firstSignerAccount === undefined) return replyWithoutActiveAccount(websiteTabConnections, request)
		// The signer round trip can change settings and the active address; continue on a fresh context.
		const refreshedContext = await readInterceptedRequestContext(websiteTabConnections, socket.tabId)
		const refreshedSettings = refreshedContext.settings
		let refreshedActiveAddress = refreshedContext.activeAddress
		let readRefreshedActiveAddress = refreshedContext.readActiveAddress
		if (refreshedActiveAddress === undefined) {
			const signerStateToken = getConfirmedSignerStateToken(websiteTabConnections, socket.tabId)
			if (signerStateToken !== undefined) {
				const firstSignerAddress = await getFirstSignerAddress(firstSignerAccount, refreshedSettings)
				if (isSignerStateTokenCurrent(websiteTabConnections, signerStateToken)) {
					refreshedActiveAddress = firstSignerAddress
					readRefreshedActiveAddress = readCurrentFirstSignerAddress(websiteTabConnections, socket.tabId)
				}
			}
		}
		if (refreshedActiveAddress === undefined) return replyWithoutActiveAccount(websiteTabConnections, request)
		const refreshedAccess = verifyAccess(websiteTabConnections, socket, false, websiteOrigin, refreshedActiveAddress, refreshedSettings, { ignoreConnectionApproval: true })
		if (refreshedAccess !== 'hasAccess') return replyWithoutActiveAccount(websiteTabConnections, request)
		return await executeOnceWebsiteLoads(port, websiteOrigin, websitePromise, simulationServicesOwner, socket, request, websiteTabConnections, publishRpcConnectionStatus, { settings: refreshedSettings, activeAddress: refreshedActiveAddress, readActiveAddress: readRefreshedActiveAddress })
	}

	if (access === 'noAccess' || activeAddress === undefined) {
		switch (request.method) {
			case 'eth_accounts': return replyWithEmptyAccounts(websiteTabConnections, request)
			case 'wallet_getPermissions': return replyWithEmptyPermissions(websiteTabConnections, request)
			// if user has not given access, assume we are on chain 1
			case 'eth_chainId': return replyToInterceptedRequest(websiteTabConnections, { type: 'result', method: request.method, result: 1n, uniqueRequestIdentifier: request.uniqueRequestIdentifier })
			case 'net_version': return replyToInterceptedRequest(websiteTabConnections, { type: 'result', method: request.method, result: 1n, uniqueRequestIdentifier: request.uniqueRequestIdentifier })
			default: break
		}
	}

	switch (access) {
		case 'askAccess': {
			const website = await websitePromise
			return await requestAccessFromUser(websiteTabConnections, socket, website, request, activeAddress, settings, activeAddress, createInterceptedRequestReplay(simulationServicesOwner, websiteTabConnections, publishRpcConnectionStatus))
		}
		case 'noAccess': return refuseAccess(websiteTabConnections, request)
		case 'hasAccess': {
			if (activeAddress === undefined) return refuseAccess(websiteTabConnections, request)
			return await executeOnceWebsiteLoads(port, websiteOrigin, websitePromise, simulationServicesOwner, socket, request, websiteTabConnections, publishRpcConnectionStatus, { ...requestContext, activeAddress })
		}
		default: assertNever(access)
	}
}

// What a request was decided and executes on: the network, the mode and the active addresses it executes with, and the access policy's answers for this website and the request's address entry. Comparing the policy's answers rather than the fields it reads keeps every policy input in, including the address's own askForAddressAccess. The popup's open page and other websites' entries are left out, so changes to them do not make a waiting request decide again.
function getRequestDecisionFingerprint(settings: Settings, websiteOrigin: string, activeAddress: AddressBookEntry) {
	return stringifyJSONWithBigInts([
		settings.activeRpcNetwork,
		settings.simulationMode,
		settings.activeSimulationAddress,
		settings.activeSigningSafeAddress,
		settings.useSignersAddressAsActiveAddress,
		activeAddress.address,
		getWebsiteAccessApprovalState(settings.websiteAccess, websiteOrigin),
		getWebsiteAddressAccessApprovalState(settings.websiteAccess, websiteOrigin, activeAddress),
	])
}

// Waits for the website metadata, which can take as long as the tab takes to load, then executes the request on the snapshot its access was decided on. If anything that decided it changed meanwhile, for example the user revoked the website's access, stopped sharing the address without asking, switched the active address or mode, or switched networks (which installs simulation services for the new network), access is decided again on the current state instead. Deciding again passes the loaded metadata, and a request whose metadata had already loaded did not wait, so it executes without this check and a request decides at most twice. The services are still taken from the owner when the request executes, a few storage reads later, and some writers install services outside the settings transition lock, so a switch inside that short window can still mix networks; #1657 tracks publishing settings and services through one boundary.
async function executeOnceWebsiteLoads(port: browser.runtime.Port | undefined, websiteOrigin: string, websitePromise: Promise<Website> | Website, simulationServicesOwner: SimulationServicesOwner, socket: WebsiteSocket, request: InterceptedRequest, websiteTabConnections: WebsiteTabConnections, publishRpcConnectionStatus: PublishRpcConnectionStatus, { settings, activeAddress, readActiveAddress }: InterceptedRequestContext & { readonly activeAddress: AddressBookEntry }) {
	if (!('then' in websitePromise)) return await handleContentScriptMessage(simulationServicesOwner, websiteTabConnections, request, websitePromise, settings, activeAddress, publishRpcConnectionStatus)
	const website = await websitePromise
	const currentSettings = await getSettings()
	// The active address is resolved again the way it was for the decision: the wallet can switch accounts, and editing the address book entry, for example to ask before sharing the address, changes the policy's answer without changing the settings.
	const currentActiveAddress = await readActiveAddress(currentSettings)
	if (currentActiveAddress === undefined || getRequestDecisionFingerprint(currentSettings, websiteOrigin, currentActiveAddress) !== getRequestDecisionFingerprint(settings, websiteOrigin, activeAddress)) {
		return await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, request, websiteTabConnections, publishRpcConnectionStatus)
	}
	return await handleContentScriptMessage(simulationServicesOwner, websiteTabConnections, request, website, settings, activeAddress, publishRpcConnectionStatus)
}

async function handleContentScriptMessage(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, request: InterceptedRequest, website: Website, settings: Settings, activeAddress: AddressBookEntry, publishRpcConnectionStatus: PublishRpcConnectionStatus) {
	try {
		const requestWithDefinedParams = getRequestWithDefinedParams(request)
		const currentChainEntries = await getUserAddressBookEntriesForChainIdMorePreciseFirst(settings.activeRpcNetwork.chainId)
		const signerTabState = await getTabState(request.uniqueRequestIdentifier.requestSocket.tabId)
		const safeSigningMode = isActiveSigningSafe(activeAddress, settings.simulationMode, settings.activeSigningSafeAddress, settings.activeRpcNetwork.chainId, signerTabState.signerAccounts, currentChainEntries)
		let rpcContext: RpcRequestContext = { request }
		if (request.method === 'safe_apps_request') {
			const admission = await prepareSafeAppsRequest(simulationServicesOwner.getCurrent().ethereum, websiteTabConnections, request, website, activeAddress, settings, safeSigningMode)
			if (admission.kind === 'reply') return replyToInterceptedRequest(websiteTabConnections, admission.reply)
			rpcContext = admission.context
		}
		const selectedWalletAccount = getWalletSelectedAccount(signerTabState)
		// The request's active entry is captured before async handling begins. Recheck Safe ownership without rerouting the request if the popup selects another account meanwhile.
		const simulationOverlayEnabled = settings.simulationMode || safeSigningMode
		const walletSelectedSafeSigner = safeSigningMode ? selectedWalletAccount : undefined
		const resolved = await handleRPCRequest(simulationServicesOwner, websiteTabConnections, request.uniqueRequestIdentifier.requestSocket, website, rpcContext, settings, activeAddress.address, publishRpcConnectionStatus, simulationOverlayEnabled, safeSigningMode, walletSelectedSafeSigner)
		await persistApprovedAccountsForAccountRequest(
			websiteTabConnections,
			request,
			website,
			settings,
			resolved,
			activeAddress.address,
		)
		replayProviderStateForAccountRequest(websiteTabConnections, request, resolved, activeAddress.address)
		return replyToInterceptedRequest(websiteTabConnections, { ...requestWithDefinedParams, ...resolved })
	} catch (error: unknown) {
		if (isFailedToFetchError(error)) {
			return replyToInterceptedRequest(websiteTabConnections, { type: 'result', ...getRequestWithDefinedParams(request), ...METAMASK_ERROR_NOT_CONNECTED_TO_CHAIN })
		}
		if (error instanceof JsonRpcResponseError) {
			return replyToInterceptedRequest(websiteTabConnections, { type: 'result', ...getRequestWithDefinedParams(request), ...error.serialize() })
		}
		await reportUnexpectedError(error)
		return replyToInterceptedRequest(websiteTabConnections, {
			type: 'result',
			...getRequestWithDefinedParams(request),
			error: {
				code: 123456,
				message: 'Unknown error'
			},
		})
	}
}

// Replays a request that waited for website access back through this router.
export function createInterceptedRequestReplay(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, publishRpcConnectionStatus: PublishRpcConnectionStatus): ReplayInterceptedRequest {
	return async ({ website, socket, request }) => await handleInterceptedRequest(undefined, website.websiteOrigin, website, simulationServicesOwner, socket, request, websiteTabConnections, publishRpcConnectionStatus)
}
