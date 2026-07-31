import { type InpageScriptRequest, PopupMessage, type RPCReply, type Settings } from '../types/interceptor-messages.js'
import 'webextension-polyfill'
import { getTabState, getUserAddressBookEntries, getUserAddressBookEntriesForChainIdMorePreciseFirst, promoteRpcAsPrimary, updateTransactionState } from './storageVariables.js'
import { changeSimulationMode, getSettings, trackPreviousActiveAddressForMakeMeRichList, updateWebsiteAccess } from './settings.js'
import { blockNumber, call, chainId, estimateGas, gasPrice, getAccounts, getBalance, getBlockByNumber, getBlockByHash, getCode, getFilterChanges, getFilterLogs, getLogs, getPermissions, getStorageAt, getTransactionByHash, getTransactionCount, getTransactionReceipt, handleIterceptorError, installNewFilter, maxPriorityFeePerGas, netVersion, personalSign, requestInterceptorSimulatorStack, requestPermissions, sendTransaction, subscribe, switchEthereumChain, ethSimulateV1, feeHistory, uninstallNewFilter, unsubscribe, web3ClientVersion } from './simulationModeHanders.js'
import { PASSTHROUGH_STATE, type ResolvedExecutionSimulationState, type ResolvedSimulationInput, type SimulationStateInput, type WebsiteCreatedEthereumTransactionOrFailed, toResolvedExecutionSimulationState, toResolvedSimulationInput, toResolvedSimulationState } from '../types/visualizer-types.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { askForSignerAccountsFromSignerIfNotAvailable, requestAccessFromUser } from './windows/interceptorAccess.js'
import { METAMASK_ERROR_FAILED_TO_PARSE_REQUEST, METAMASK_ERROR_NOT_AUTHORIZED, METAMASK_ERROR_NOT_CONNECTED_TO_CHAIN, METAMASK_ERROR_PROVIDER_DISCONNECTED, METAMASK_ERROR_USER_REJECTED_REQUEST, ERROR_INTERCEPTOR_DISABLED, NEW_BLOCK_ABORT, JSON_RPC_ERROR_CODE_INTERNAL_ERROR } from '../utils/constants.js'
import { clearWebsiteConnectionIntent, finalizeWebsiteAccessChange, hasAccess as getWebsiteAccessApprovalState, hasAddressAccess as getWebsiteAddressAccessApprovalState, persistWebsiteAccessChange, sendAccountsChangedToPort, sendActiveAccountChangeToApprovedWebsitePorts, sendMessageToApprovedWebsitePorts, updateWebsiteApprovalAccesses, verifyAccess, withSuppressedUnscopedConnectionEventsForSocket } from './accessManagement.js'
import { getActiveAddressEntry, identifyAddress } from './metadataUtils.js'
import { getActiveAddress, sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { assertNever } from '../utils/typescript.js'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { appendTransactionsToInput, getSignedTransactionForSimulation } from '../simulation/services/SimulationModeEthereumClientService.js'
import { Semaphore } from '../utils/semaphore.js'
import { JsonRpcResponseError, reportUnexpectedError, isExpectedInfrastructureError, isFailedToFetchError, isNewBlockAbort } from '../utils/errors.js'
import { InterceptedRequest, type UniqueRequestIdentifier, type WebsiteSocket } from '../utils/requests.js'
import { replyToInterceptedRequest } from './messageSending.js'
import { bumpPopupRefreshGeneration } from './popupRefreshGeneration.js'
import { EthereumJsonRpcRequest, type EthGetStorageAtParams, type SendRawTransactionParams, type SendTransactionParams, SupportedEthereumJsonRpcRequestMethods, type WalletAddEthereumChain, WalletRevokePermissions } from '../types/JsonRpc-types.js'
import type { Website } from '../types/websiteAccessTypes.js'
import type { ConfirmTransactionTransactionSingleVisualization } from '../types/accessRequest.js'
import type { RpcNetwork } from '../types/rpc.js'
import { serialize } from '../types/wire-types.js'
import { last } from '../utils/array.js'
import { connectedToSigner, ethAccountsReply, signerChainChanged, signerReply, walletSwitchEthereumChainReply } from './providerMessageHandlers.js'
import { makeSureInterceptorIsNotSleeping } from './sleeping.js'
import type { PublishRpcConnectionStatus } from './rpcSlowRequestTracking.js'
import { decodeEthereumError } from '../utils/errorDecoding.js'
import { buildExecutionSimulationStateFromPreparedInput, createSimulationStateWithNonceAndBaseFeeFixing, getCurrentSimulationInput, prepareSimulationInputForRpc, visualizeSimulatorState } from './simulationUpdating.js'
import { PopupReplyOption } from '../types/interceptor-reply-messages.js'
import { updatePopupVisualisationIfNeeded } from './popupVisualisationUpdater.js'
import type { TokenPriceService } from '../simulation/services/priceEstimator.js'
import type { ResetSimulationServices } from '../simulation/serviceLifecycle.js'
import { isAccountConnectionMethod, isAccountOnlyMethod } from './accountRequestMethods.js'
import type { ErrorWithCodeAndOptionalData } from '../types/error.js'
import { getActiveAddressForCurrentSignerState, getConfirmedSignerStateToken, isSignerStateTokenCurrent, sendCallbackToConfirmedSignerOwner } from './signerStateOwnership.js'
import { handleWatchAssetRequest, initializeWatchAssetWindowListeners, processWatchAssetQueue } from './windows/watchAsset.js'
import { getSimulationErrorAbis } from './simulationErrorAbi.js'
import { isSafeEntryWithSafeSigner } from '../types/addressBookTypes.js'
import type { SafeTransactionSigningRequest } from '../types/safeTypes.js'
import { createSafeExecutionPreSimulationTransaction } from '../safe/safeSimulation.js'
import { getSafeModeRpcPolicyReply } from '../safe/safeRequestPolicy.js'
import { dispatchPopupMessage } from './popupMessageDispatcher.js'
import { getWatchAssetRpcParseFailureReply } from './watchAssetRpc.js'
import { createMethodHandlerFor, hasOwnKey } from '../utils/methodHandlers.js'
import { getWalletCapabilities } from './walletCapabilities.js'
import { getWalletGetCapabilitiesParseFailureReply } from './walletGetCapabilitiesRpc.js'

if (initializeWatchAssetWindowListeners()) {
	void processWatchAssetQueue(undefined).catch(async (error: unknown) => {
		await reportUnexpectedError(error, { code: 'watch_asset_startup_recovery_failed' })
	})
}

const simulationAbortController = new AbortController()
const RPC_PARSE_FAILURE_HANDLERS = [getWatchAssetRpcParseFailureReply, getWalletGetCapabilitiesParseFailureReply]
const JSON_RPC_METHOD_NOT_FOUND = -32601
const INTERNAL_PROVIDER_METHODS = [
	'connected_to_signer',
	'eth_accounts_reply',
	'InterceptorError',
	'signer_chainChanged',
	'signer_reply',
	'wallet_switchEthereumChain_reply',
] as const

const isInternalProviderMethod = (method: string) => INTERNAL_PROVIDER_METHODS.some((internalMethod) => internalMethod === method)

export async function getUpdatedSimulationState(ethereum: EthereumClientService, simulationInput?: SimulationStateInput) {
	try {
		return toResolvedSimulationState(await createSimulationStateWithNonceAndBaseFeeFixing(simulationInput ?? await getCurrentSimulationInput(), ethereum))
	} catch(error: unknown) {
		if (isExpectedInfrastructureError(error)) return PASSTHROUGH_STATE
		await reportUnexpectedError(error, { code: 'simulation_state_refresh_failed' })
	}
	return PASSTHROUGH_STATE
}

export async function getUpdatedSimulationStackSnapshot(ethereum: EthereumClientService, simulationMode: boolean) {
	if (!simulationMode) return { simulationInput: PASSTHROUGH_STATE, simulationState: PASSTHROUGH_STATE }
	const simulationInput = await getCurrentSimulationInput()
	return {
		simulationInput: toResolvedSimulationInput(simulationInput),
		simulationState: await getUpdatedSimulationState(ethereum, simulationInput),
	}
}

let confirmTransactionAbortController = new AbortController()
export async function refreshConfirmTransactionSimulation(
	ethereum: EthereumClientService,
	tokenPriceService: TokenPriceService,
	activeAddress: bigint,
	simulationMode: boolean,
	uniqueRequestIdentifier: UniqueRequestIdentifier,
	transactionToSimulate: WebsiteCreatedEthereumTransactionOrFailed,
	safeSigningRequest?: SafeTransactionSigningRequest,
): Promise<ConfirmTransactionTransactionSingleVisualization | undefined> {
	const info = {
		uniqueRequestIdentifier,
		transactionToSimulate,
		simulationMode,
		activeAddress,
		signerName: (await getTabState(uniqueRequestIdentifier.requestSocket.tabId)).signerName,
		tabIdOpenedFrom: uniqueRequestIdentifier.requestSocket.tabId,
	}
	sendPopupMessageToOpenWindows({ method: 'popup_confirm_transaction_simulation_started' } as const, 'confirmTransaction')
	confirmTransactionAbortController.abort(NEW_BLOCK_ABORT)
	confirmTransactionAbortController = new AbortController()
	const thisConfirmTransactionAbortController = confirmTransactionAbortController
	const simulationStartedTimestamp = new Date()
	const simulationInput = await getCurrentSimulationInput()
	try {
		const getNewVisualizedSimulationState = async () => {
			const preSimulationTransaction = transactionToSimulate.success
				? safeSigningRequest === undefined
					? {
						signedTransaction: getSignedTransactionForSimulation(transactionToSimulate),
						website: transactionToSimulate.website,
						created: transactionToSimulate.created,
						originalRequestParameters: transactionToSimulate.originalRequestParameters,
						transactionIdentifier: transactionToSimulate.transactionIdentifier
					}
					: createSafeExecutionPreSimulationTransaction(transactionToSimulate, safeSigningRequest)
				: undefined
			const simulationStateWithNewTransaction = preSimulationTransaction === undefined
				? simulationInput
				: appendTransactionsToInput(simulationInput, [preSimulationTransaction], undefined, {}, safeSigningRequest !== undefined)
				const updatedSimulationState = await createSimulationStateWithNonceAndBaseFeeFixing(simulationStateWithNewTransaction, ethereum)
				return await visualizeSimulatorState(updatedSimulationState, ethereum, tokenPriceService, thisConfirmTransactionAbortController)
		}
		const visualizedSimulatorState = await getNewVisualizedSimulationState()
		const availableAbis = visualizedSimulatorState.addressBookEntries
			.map((entry) => 'abi' in entry && entry.abi !== undefined ? entry.abi : undefined)
			.filter((abiOrUndefined): abiOrUndefined is string => abiOrUndefined !== undefined)
		if (visualizedSimulatorState.visualizedSimulationState.success === false) {
			return { statusCode: 'failed' as const, data: {
				...info,
				simulationStartedTimestamp,
				error: { ...visualizedSimulatorState.visualizedSimulationState.jsonRpcError.error, decodedErrorMessage: visualizedSimulatorState.visualizedSimulationState.jsonRpcError.error.message },
				simulationState: {
					blockNumber: visualizedSimulatorState.simulationState.blockNumber,
					simulationConductedTimestamp: new Date(),
				}
			} }
		}
		const blocks = visualizedSimulatorState.visualizedSimulationState.visualizedBlocks
		const lastTransaction = last(last(blocks)?.simulatedAndVisualizedTransactions ?? [])
		return {
			statusCode: 'success' as const,
			data: {
				...info,
				simulationStartedTimestamp,
				...visualizedSimulatorState,
				transactionToSimulate: {
					...transactionToSimulate,
					...transactionToSimulate.success ? {
						transaction: {
							...transactionToSimulate.transaction,
							nonce: lastTransaction ? lastTransaction.transaction.nonce : transactionToSimulate.transaction.nonce,
						} }
					: { error: {
						...transactionToSimulate.error,
						decodedErrorMessage: decodeEthereumError(availableAbis, transactionToSimulate.error).reason
					} }
				}
			}
		}
	} catch (error) {
		if (isNewBlockAbort(error)) return undefined
		if (isFailedToFetchError(error)) return undefined
		const isJsonRpcResponseError = error instanceof JsonRpcResponseError
		if (!isJsonRpcResponseError) await reportUnexpectedError(error, { code: 'confirm_transaction_simulation_failed' })

		const baseError = isJsonRpcResponseError
			? { code: error.code, message: error.message, data: typeof error.data === 'string' ? error.data : '0x' }
			: { code: JSON_RPC_ERROR_CODE_INTERNAL_ERROR, message: error instanceof Error ? error.message : 'Unknown simulation error', data: '0x' }
		const extractToAbi = async (): Promise<readonly string[]> => {
			const params = transactionToSimulate.originalRequestParameters.params[0]
			if (!('to' in params)) return []
			if (params.to === undefined || params.to === null) return []
			const recipient = params.to
			return await getSimulationErrorAbis(baseError.data, async () => await identifyAddress(ethereum, thisConfirmTransactionAbortController, recipient))
		}
		return { statusCode: 'failed' as const, data: {
			...info,
			simulationStartedTimestamp,
			error: { ...baseError, decodedErrorMessage: isJsonRpcResponseError ? decodeEthereumError(await extractToAbi(), baseError).reason : baseError.message },
			simulationState: {
				blockNumber: 0n,
				simulationConductedTimestamp: new Date()
			}
		} }
	}
}

async function handleRPCRequest(
	ethereum: EthereumClientService,
	tokenPriceService: TokenPriceService,
	resetSimulationServices: ResetSimulationServices,
	getSimulationInput: () => Promise<ResolvedSimulationInput>,
	getExecutionSimulationState: () => Promise<ResolvedExecutionSimulationState>,
	websiteTabConnections: WebsiteTabConnections,
	socket: WebsiteSocket,
	website: Website,
	request: InterceptedRequest,
	settings: Settings,
	activeAddress: bigint | undefined,
	publishRpcConnectionStatus: PublishRpcConnectionStatus,
	simulationOverlayEnabled: boolean,
	safeSigningMode: boolean,
	activeSafeSigner: bigint | undefined,
): Promise<RPCReply> {
	const maybeParsedRequest = EthereumJsonRpcRequest.safeParse(request)
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
	const signMessage = async (signRequest: Extract<ParsedRpcRequest, { readonly method: 'personal_sign' | 'eth_signTypedData' | 'eth_signTypedData_v1' | 'eth_signTypedData_v2' | 'eth_signTypedData_v3' | 'eth_signTypedData_v4' }>) => await personalSign(ethereum, tokenPriceService, activeAddress, signRequest, request, website, websiteTabConnections, !forwardToSigner)
	const sendEthereumTransaction = async (transactionRequest: Extract<ParsedRpcRequest, { readonly method: 'eth_sendRawTransaction' | 'eth_sendTransaction' }>) => {
		if (forwardToSigner && settings.activeRpcNetwork.httpsRpc === undefined) return getForwardingMessage(transactionRequest)
		return await sendTransaction(ethereum, tokenPriceService, activeAddress, transactionRequest, request, website, websiteTabConnections, !forwardToSigner)
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
		wallet_switchEthereumChain: rpcRequestHandler('wallet_switchEthereumChain', async (_context, rpcRequest) => await switchEthereumChain(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, rpcRequest, request, settings.simulationMode, website)),
		wallet_watchAsset: rpcRequestHandler('wallet_watchAsset', async (_context, rpcRequest) => await handleWatchAssetRequest(ethereum, websiteTabConnections, request, website, rpcRequest, {}, activeAddress)),
		wallet_requestPermissions: rpcRequestHandler('wallet_requestPermissions', async () => await requestPermissions(activeAddress, website)),
		wallet_getPermissions: rpcRequestHandler('wallet_getPermissions', async () => await getPermissions(activeAddress, website)),
		wallet_getCapabilities: rpcRequestHandler('wallet_getCapabilities', async (_context, rpcRequest) => {
			if (rpcRequest.params[0] !== activeAddress) {
				return getWalletCapabilities(rpcRequest, activeAddress, settings.activeRpcNetwork.chainId, activeSafeSigner)
			}
			if (activeSafeSigner === undefined && forwardToSigner) {
				return { type: 'forwardToSigner', replyWithSignersReply: true, ...request }
			}
			return getWalletCapabilities(rpcRequest, activeAddress, settings.activeRpcNetwork.chainId, activeSafeSigner)
		}),
		eth_accounts: rpcRequestHandler('eth_accounts', async () => await getAccounts(activeAddress)),
		eth_requestAccounts: rpcRequestHandler('eth_requestAccounts', async () => await getAccounts(activeAddress)),
		eth_gasPrice: rpcRequestHandler('eth_gasPrice', async () => await gasPrice(ethereum)),
		eth_getTransactionCount: rpcRequestHandler('eth_getTransactionCount', async (_context, rpcRequest) => await withSimulationInput((simulationInput) => getTransactionCount(ethereum, simulationInput, rpcRequest))),
		interceptor_getSimulationStack: rpcRequestHandler('interceptor_getSimulationStack', async (_context, rpcRequest) => await requestInterceptorSimulatorStack(await getUpdatedSimulationStackSnapshot(ethereum, simulationOverlayEnabled), websiteTabConnections, rpcRequest, website, request, socket)),
		eth_simulateV1: rpcRequestHandler('eth_simulateV1', async (_context, rpcRequest) => await withSimulationInput((simulationInput) => ethSimulateV1(ethereum, simulationInput, rpcRequest))),
		wallet_addEthereumChain: rpcRequestHandler('wallet_addEthereumChain', async (_context, rpcRequest) => {
			if (forwardToSigner) return getForwardingMessage(rpcRequest)
			return { type: 'result' as const, method: rpcRequest.method, error: { code: 10000, message: 'wallet_addEthereumChain not implemented' } }
		}),
		eth_getStorageAt: rpcRequestHandler('eth_getStorageAt', async (_context, rpcRequest) => {
			if (forwardToSigner) return getForwardingMessage(rpcRequest)
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
		eth_getFilterChanges: rpcRequestHandler('eth_getFilterChanges', async (_context, rpcRequest) => await withExecutionSimulationState((simulationState) => getFilterChanges(rpcRequest, ethereum, simulationState))),
		eth_getFilterLogs: rpcRequestHandler('eth_getFilterLogs', async (_context, rpcRequest) => await withExecutionSimulationState((simulationState) => getFilterLogs(rpcRequest, ethereum, simulationState))),
		InterceptorError: rpcRequestHandler('InterceptorError', async (_context, rpcRequest) => await handleIterceptorError(rpcRequest)),
	} as const satisfies Record<ParsedRpcRequest['method'], RpcRequestHandler>
	return await rpcRequestHandlers[parsedRequest.method](undefined, parsedRequest)
}

export async function resetSimulationStateFromConfig(ethereum: EthereumClientService, tokenPriceService: TokenPriceService) {
	await updateTransactionState(() => ({
		interceptorTransactionStack: { operations: [] },
		safeTransactionStacks: [],
	}))
	await updatePopupVisualisationIfNeeded(ethereum, tokenPriceService, false, false)
}

const keepTrackOfPreviousAddressforRichList = async () => {
	const previousActiveAddress = (await getSettings()).activeSimulationAddress
	await trackPreviousActiveAddressForMakeMeRichList(previousActiveAddress)
}

const changeActiveAddressAndChainSemaphore = new Semaphore(1)
export async function changeActiveAddressAndChain(
	ethereum: EthereumClientService,
	tokenPriceService: TokenPriceService,
	resetSimulationServices: ResetSimulationServices,
	websiteTabConnections: WebsiteTabConnections,
	change: {
		simulationMode: boolean,
		activeAddress?: bigint,
		rpcNetwork?: RpcNetwork,
		promptForAccessesIfNeeded?: boolean,
	},
) {

	if (change.simulationMode && change.activeAddress !== undefined) await keepTrackOfPreviousAddressforRichList()
	const previousSettings = change.rpcNetwork !== undefined ? await getSettings() : undefined

	if (change.simulationMode) {
		await changeSimulationMode({
			simulationMode: change.simulationMode,
			...('activeAddress' in change ? { activeSimulationAddress: change.activeAddress } : {}),
			...(change.rpcNetwork !== undefined ? { rpcNetwork: change.rpcNetwork } : {}),
		})
	} else {
		const activeChainId = change.rpcNetwork?.chainId ?? (await getSettings()).activeRpcNetwork.chainId
		const [allEntries, activeChainEntries] = await Promise.all([
			getUserAddressBookEntries(),
			getUserAddressBookEntriesForChainIdMorePreciseFirst(activeChainId),
		])
		const selectedSafe = change.activeAddress === undefined
			? undefined
			: allEntries.find((entry) => entry.type === 'safe' && entry.address === change.activeAddress)
		const safeEntryWithSafeSigner = change.activeAddress === undefined
			? undefined
			: activeChainEntries.find((entry) => entry.address === change.activeAddress && isSafeEntryWithSafeSigner(entry))
		await changeSimulationMode({
			simulationMode: change.simulationMode,
			...(selectedSafe === undefined && 'activeAddress' in change ? { activeSigningAddress: change.activeAddress } : {}),
			...(selectedSafe !== undefined && safeEntryWithSafeSigner === undefined ? { activeSigningAddress: undefined } : {}),
			...('activeAddress' in change ? { activeSimulationAddress: safeEntryWithSafeSigner?.address } : {}),
			...(change.rpcNetwork !== undefined ? { rpcNetwork: change.rpcNetwork } : {}),
		})
	}

	const updatedSettings = await getSettings()
	const popupRefreshGeneration = await updateWebsiteApprovalAccesses(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, updatedSettings, change.promptForAccessesIfNeeded ?? true)
	sendPopupMessageToOpenWindows({ method: 'popup_settingsUpdated', data: updatedSettings, popupRefreshGeneration })
	sendPopupMessageToOpenWindows({ method: 'popup_accounts_update' })
	await changeActiveAddressAndChainSemaphore.execute(async () => {
		if (change.rpcNetwork !== undefined) {
			const rpcChainChanged = previousSettings !== undefined && previousSettings.activeRpcNetwork.chainId !== change.rpcNetwork.chainId
			if (change.rpcNetwork.httpsRpc !== undefined) resetSimulationServices(change.rpcNetwork)
			sendMessageToApprovedWebsitePorts(websiteTabConnections, { method: 'chainChanged' as const, result: change.rpcNetwork.chainId })
			sendPopupMessageToOpenWindows({ method: 'popup_chain_update' })

			// reset simulation if chain id was changed
			if (updatedSettings.simulationMode && rpcChainChanged) {
				await resetSimulationStateFromConfig(ethereum, tokenPriceService)
			} else if (updatedSettings.simulationMode) {
				await updatePopupVisualisationIfNeeded(ethereum, tokenPriceService, false, false)
			}
		}
		// inform website about this only after we have updated simulation, as they often query the balance right after
		await sendActiveAccountChangeToApprovedWebsitePorts(websiteTabConnections, await getSettings())
	})
}

export async function changeActiveRpc(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, resetSimulationServices: ResetSimulationServices, websiteTabConnections: WebsiteTabConnections, rpcNetwork: RpcNetwork, simulationMode: boolean, signerTabId: number | undefined) {
	if (simulationMode) {
		await changeActiveAddressAndChain(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, { simulationMode, rpcNetwork })
		return { type: 'completedLocally' as const }
	}
	// The signer already confirmed this chain through chainChanged, so no wallet request is needed.
	if (rpcNetwork.chainId === (await getSettings()).activeRpcNetwork.chainId) {
		await changeActiveAddressAndChain(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, { simulationMode, rpcNetwork })
		return { type: 'signerRequestNotNeeded' as const }
	}
	const signerStateToken = signerTabId !== undefined
		&& sendCallbackToConfirmedSignerOwner(websiteTabConnections, signerTabId, { method: 'request_signer_to_wallet_switchEthereumChain', result: rpcNetwork.chainId })
	const settings = await getSettings()
	const popupRefreshGeneration = bumpPopupRefreshGeneration()
	await sendPopupMessageToOpenWindows({ method: 'popup_settingsUpdated', data: settings, popupRefreshGeneration })
	await promoteRpcAsPrimary(rpcNetwork)
	return signerStateToken === false
		? { type: 'signerUnavailable' as const }
		: { type: 'signerRequestSent' as const, signerStateToken }
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
	ethereum: EthereumClientService,
	tokenPriceService: TokenPriceService,
	resetSimulationServices: ResetSimulationServices,
	websiteTabConnections: WebsiteTabConnections,
	request: InterceptedRequest,
	website: Website,
	resolved: RPCReply,
	activeAddress: bigint | undefined,
): Promise<void> {
	const accounts = getApprovedAccountsForAccountRequest(request, resolved, activeAddress)
	if (accounts === undefined || accounts.length === 0) return

	const settings = await getSettings()
	for (const account of accounts) {
		const addressEntry = await getActiveAddressEntry(account)
		const existingApprovalState = getWebsiteAddressAccessApprovalState(settings.websiteAccess, website.websiteOrigin, addressEntry)
		if (addressEntry.askForAddressAccess === false) continue
		if (existingApprovalState === 'hasAccess') continue
		await persistWebsiteAccessChange(
			ethereum,
			tokenPriceService,
			resetSimulationServices,
			websiteTabConnections,
			website,
			true,
			account,
			false,
		)
	}
}

async function revokeWebsitePermissions(
	ethereum: EthereumClientService,
	tokenPriceService: TokenPriceService,
	resetSimulationServices: ResetSimulationServices,
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
	await finalizeWebsiteAccessChange(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, await getSettings(), false)
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

async function discoverAccountRequestAddressContext(
	websiteTabConnections: WebsiteTabConnections,
	socket: WebsiteSocket,
	request: InterceptedRequest,
	websiteOrigin: string,
) {
	const settings = await getSettings()
	const activeAddress = await getActiveAddressForRequest(settings, websiteTabConnections, socket.tabId)
	if (activeAddress !== undefined) return { settings, activeAddress, requestedSignerAccountsForAddressConsent: false, signerAccountError: undefined }
	if (!isAccountConnectionMethod(request.method)) return { settings, activeAddress, requestedSignerAccountsForAddressConsent: false, signerAccountError: undefined }
	const websiteAccess = getWebsiteAccessApprovalState(settings.websiteAccess, websiteOrigin)
	if (websiteAccess === 'noAccess' || websiteAccess === 'interceptorDisabled') return { settings, activeAddress, requestedSignerAccountsForAddressConsent: false, signerAccountError: undefined }

	const signerAccountsResult = await askForSignerAccountsFromSignerIfNotAvailable(websiteTabConnections, socket, true)
	const refreshedSettings = await getSettings()
	const refreshedActiveAddress = await getActiveAddressForRequest(refreshedSettings, websiteTabConnections, socket.tabId)
	if (refreshedActiveAddress !== undefined) return { settings: refreshedSettings, activeAddress: refreshedActiveAddress, requestedSignerAccountsForAddressConsent: true, signerAccountError: signerAccountsResult.error }
	const firstSignerAddress = signerAccountsResult.accounts[0] === undefined ? undefined : await getActiveAddressEntry(signerAccountsResult.accounts[0])
	return { settings: refreshedSettings, activeAddress: firstSignerAddress, requestedSignerAccountsForAddressConsent: true, signerAccountError: signerAccountsResult.error }
}

const isSignerProviderDisconnectedError = (error: ErrorWithCodeAndOptionalData | undefined): error is ErrorWithCodeAndOptionalData => error?.code === METAMASK_ERROR_PROVIDER_DISCONNECTED
const isSignerAccountAccessRejectedError = (error: ErrorWithCodeAndOptionalData | undefined): error is ErrorWithCodeAndOptionalData => error?.code === METAMASK_ERROR_USER_REJECTED_REQUEST
const isTerminalSignerAccountConnectionError = (error: ErrorWithCodeAndOptionalData | undefined): error is ErrorWithCodeAndOptionalData => {
	return isSignerProviderDisconnectedError(error) || isSignerAccountAccessRejectedError(error)
}

function replyWithSignerAccountError(websiteTabConnections: WebsiteTabConnections, request: InterceptedRequest, error: ErrorWithCodeAndOptionalData) {
	// Injected-wallet connection UIs commonly treat 4001 as the only terminal account-access failure.
	// Keep the more precise 4900 internally, but expose unavailable page-level wallet access as a rejected interactive connection.
	const publicError = isAccountConnectionMethod(request.method) && isSignerProviderDisconnectedError(error)
		? { ...error, code: METAMASK_ERROR_USER_REJECTED_REQUEST }
		: error
	return replyToInterceptedRequest(websiteTabConnections, {
		type: 'result',
		...getRequestWithDefinedParams(request),
		error: publicError,
	})
}

export const handleInterceptedRequest = async (port: browser.runtime.Port | undefined, websiteOrigin: string, websitePromise: Promise<Website> | Website, ethereum: EthereumClientService, tokenPriceService: TokenPriceService, resetSimulationServices: ResetSimulationServices, socket: WebsiteSocket, request: InterceptedRequest, websiteTabConnections: WebsiteTabConnections, publishRpcConnectionStatus: PublishRpcConnectionStatus): Promise<unknown> => {
	const initialSettings = await getSettings()
	if (request.method === 'wallet_revokePermissions') {
		const parsedRequest = parseWalletRevokePermissionsRequest(websiteTabConnections, request)
		if (parsedRequest === undefined) return
		const result = await revokeWebsitePermissions(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, websiteOrigin)
		return replyToInterceptedRequest(websiteTabConnections, { ...getRequestWithDefinedParams(request), ...result })
	}
	const initialActiveAddress = await getActiveAddressForRequest(initialSettings, websiteTabConnections, socket.tabId)
	if (request.interceptorInternalRequest !== true && isInternalProviderMethod(request.method)) return refusePublicInternalProviderMethod(websiteTabConnections, request)
	const providerHandler = getProviderHandler(request.method)
	const identifiedMethod = providerHandler.method
	if (identifiedMethod !== 'notProviderMethod') {
		if (port === undefined) return
		const providerCallbackApproval = request.method === 'eth_accounts_reply'
			? 'hasAccess'
			: getWebsiteAccessApprovalState(initialSettings.websiteAccess, websiteOrigin)
		const providerCallbackActiveAddress = initialActiveAddress !== undefined && getWebsiteAddressAccessApprovalState(initialSettings.websiteAccess, websiteOrigin, initialActiveAddress) === 'hasAccess'
			? initialActiveAddress.address
			: undefined
		const providerHandlerReturn = await providerHandler.func(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, port, request, providerCallbackApproval, providerCallbackActiveAddress)
		if (providerHandlerReturn.type === 'doNotReply') return
		const message: InpageScriptRequest = { uniqueRequestIdentifier: request.uniqueRequestIdentifier, ...providerHandlerReturn }
		return replyToInterceptedRequest(websiteTabConnections, message)
	}
	const { settings, activeAddress, requestedSignerAccountsForAddressConsent, signerAccountError } = await discoverAccountRequestAddressContext(websiteTabConnections, socket, request, websiteOrigin)
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
		const result: unknown = await handleInterceptedRequest(port, websiteOrigin, websitePromise, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, publishRpcConnectionStatus)
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
		const refreshedSettings = await getSettings()
		let refreshedActiveAddress = await getActiveAddressForRequest(refreshedSettings, websiteTabConnections, socket.tabId)
		if (refreshedActiveAddress === undefined) {
			const signerStateToken = getConfirmedSignerStateToken(websiteTabConnections, socket.tabId)
			if (signerStateToken !== undefined) {
				const firstSignerAddress = await getActiveAddressEntry(firstSignerAccount)
				if (isSignerStateTokenCurrent(websiteTabConnections, signerStateToken)) refreshedActiveAddress = firstSignerAddress
			}
		}
		if (refreshedActiveAddress === undefined) return replyWithoutActiveAccount(websiteTabConnections, request)
		const refreshedAccess = verifyAccess(websiteTabConnections, socket, false, websiteOrigin, refreshedActiveAddress, refreshedSettings, { ignoreConnectionApproval: true })
		if (refreshedAccess !== 'hasAccess') return replyWithoutActiveAccount(websiteTabConnections, request)
		return await handleContentScriptMessage(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, request, await websitePromise, refreshedActiveAddress.address, publishRpcConnectionStatus)
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
		case 'askAccess': return await gateKeepRequestBehindAccessDialog(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, socket, request, await websitePromise, activeAddress?.address, await getSettings(), publishRpcConnectionStatus)
		case 'noAccess': return refuseAccess(websiteTabConnections, request)
		case 'hasAccess': {
			if (activeAddress === undefined) return refuseAccess(websiteTabConnections, request)
			const website = await websitePromise
			return await handleContentScriptMessage(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, request, website, activeAddress.address, publishRpcConnectionStatus)
		}
		default: assertNever(access)
	}
}

async function handleContentScriptMessage(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, resetSimulationServices: ResetSimulationServices, websiteTabConnections: WebsiteTabConnections, request: InterceptedRequest, website: Website, activeAddress: bigint | undefined, publishRpcConnectionStatus: PublishRpcConnectionStatus) {
	try {
		const requestWithDefinedParams = getRequestWithDefinedParams(request)
		const settings = await getSettings()
		const activeAddressBookEntry = activeAddress === undefined
			? undefined
			: (await getUserAddressBookEntriesForChainIdMorePreciseFirst(settings.activeRpcNetwork.chainId)).find((entry) => entry.address === activeAddress)
		const simulationOverlayEnabled = settings.simulationMode || activeAddressBookEntry?.type === 'safe'
		const safeSigningMode = !settings.simulationMode && isSafeEntryWithSafeSigner(activeAddressBookEntry)
		const activeSafeSigner = safeSigningMode ? activeAddressBookEntry.safeSignerAddress : undefined
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
		const resolved = await handleRPCRequest(ethereum, tokenPriceService, resetSimulationServices, getSimulationInput, getExecutionSimulationState, websiteTabConnections, request.uniqueRequestIdentifier.requestSocket, website, request, settings, activeAddress, publishRpcConnectionStatus, simulationOverlayEnabled, safeSigningMode, activeSafeSigner)
		await persistApprovedAccountsForAccountRequest(
			ethereum,
			tokenPriceService,
			resetSimulationServices,
			websiteTabConnections,
			request,
			website,
			resolved,
			activeAddress,
		)
		replayProviderStateForAccountRequest(websiteTabConnections, request, resolved, activeAddress)
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

export function refuseAccess(websiteTabConnections: WebsiteTabConnections, request: InterceptedRequest) {
	return replyToInterceptedRequest(websiteTabConnections, {
		type: 'result',
		...request,
		error: {
			code: METAMASK_ERROR_NOT_AUTHORIZED,
			message: 'The requested method and/or account has not been authorized by the user.'
		},
	})
}

async function gateKeepRequestBehindAccessDialog(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, resetSimulationServices: ResetSimulationServices, websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, request: InterceptedRequest, website: Website, currentActiveAddress: bigint | undefined, settings: Settings, publishRpcConnectionStatus: PublishRpcConnectionStatus) {
	const activeAddress = currentActiveAddress !== undefined ? await getActiveAddressEntry(currentActiveAddress) : undefined
	return await requestAccessFromUser(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, socket, website, request, activeAddress, settings, currentActiveAddress, publishRpcConnectionStatus)
}

export async function popupMessageHandler(
	websiteTabConnections: WebsiteTabConnections,
	ethereum: EthereumClientService,
	tokenPriceService: TokenPriceService,
	resetSimulationServices: ResetSimulationServices,
	request: unknown,
	settings: Settings,
	publishRpcConnectionStatus: PublishRpcConnectionStatus,
) {
	const maybeParsedRequest = PopupMessage.safeParse(request)
	if (maybeParsedRequest.success === false) {
		console.warn({ request })
		console.warn(maybeParsedRequest.fullError)
		return {
			error: {
				message: maybeParsedRequest.fullError === undefined ? 'Unknown parsing error' : maybeParsedRequest.fullError.toString(),
				code: METAMASK_ERROR_FAILED_TO_PARSE_REQUEST,
			}
		}
	}
	const parsedRequest = maybeParsedRequest.value
	try {
		const requestReply = await dispatchPopupMessage({
			websiteTabConnections,
			ethereum,
			tokenPriceService,
			resetSimulationServices,
			settings,
			publishRpcConnectionStatus,
			simulationAbortController,
			confirmTransactionAbortController,
			resetSimulationState: async () => await resetSimulationStateFromConfig(ethereum, tokenPriceService),
		}, parsedRequest)
		if (requestReply === undefined) return undefined
		return PopupReplyOption.serialize(requestReply)
	} catch(error: unknown) {
		if (isExpectedInfrastructureError(error)) return
		throw error
	}
}
