import { type InpageScriptRequest, PopupMessage, type RPCReply, type Settings } from '../types/interceptor-messages.js'
import 'webextension-polyfill'
import { getTabState, promoteRpcAsPrimary, setLatestUnexpectedError, updateInterceptorTransactionStack } from './storageVariables.js'
import { changeSimulationMode, getSettings, trackPreviousActiveAddressForMakeMeRichList, updateWebsiteAccess } from './settings.js'
import { blockNumber, call, chainId, estimateGas, gasPrice, getAccounts, getBalance, getBlockByNumber, getBlockByHash, getCode, getFilterChanges, getFilterLogs, getLogs, getPermissions, getTransactionByHash, getTransactionCount, getTransactionReceipt, handleIterceptorError, installNewFilter, netVersion, personalSign, requestInterceptorSimulatorStack, requestPermissions, sendTransaction, subscribe, switchEthereumChain, ethSimulateV1, feeHistory, uninstallNewFilter, unsubscribe, web3ClientVersion } from './simulationModeHanders.js'
import { changeActiveAddress, changePage, confirmDialog, removeTransactionOrSignedMessage, requestAccountsFromSigner, refreshPopupConfirmTransactionSimulation, confirmRequestAccess, changeInterceptorAccess, changeChainDialog, popupChangeActiveRpc, enableSimulationMode, addOrModifyAddressBookEntry, getAddressBookData, removeAddressBookEntry, refreshHomeData, interceptorAccessChangeAddressOrRefresh, refreshPopupConfirmTransactionMetadata, changeSettings, importSettings, exportSettings, setNewRpcList, simulateGovernanceContractExecutionOnPass, openNewTab, settingsOpened, changeAddOrModifyAddressWindowState, requestAbiAndNameFromBlockExplorer, openWebPage, disableInterceptor, requestNewHomeData, requestHomePageBootstrap, setEnsNameForHash, simulateGnosisSafeTransactionOnPass, retrieveWebsiteAccess, blockOrAllowExternalRequests, removeWebsiteAccess, allowOrPreventAddressAccessForWebsite, removeWebsiteAddressAccess, forceSetGasLimitForTransaction, changePreSimulationBlockTimeManipulation, setTransactionOrMessageBlockTimeManipulator, modifyMakeMeRich, requestMakeMeRichList, requestActiveAddresses, requestSimulationMode, requestLatestUnexpectedError, fetchSimulationStackRequestConfirmation, reportUnexpectedErrorInWindow, requestInterceptorSimulationInput, importSimulationStack, requestCompleteVisualizedSimulation, requestSimulationMetadata, requestIdentifyAddress, popupReadyAndListening } from './popupMessageHandlers.js'
import { PASSTHROUGH_STATE, type ResolvedExecutionSimulationState, type ResolvedSimulationInput, type ResolvedSimulationState, type WebsiteCreatedEthereumUnsignedTransaction, type WebsiteCreatedEthereumUnsignedTransactionOrFailed, toResolvedExecutionSimulationState, toResolvedSimulationInput, toResolvedSimulationState } from '../types/visualizer-types.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { askForSignerAccountsFromSignerIfNotAvailable, interceptorAccessMetadataRefresh, requestAccessFromUser } from './windows/interceptorAccess.js'
import { METAMASK_ERROR_FAILED_TO_PARSE_REQUEST, METAMASK_ERROR_NOT_AUTHORIZED, METAMASK_ERROR_NOT_CONNECTED_TO_CHAIN, METAMASK_ERROR_PROVIDER_DISCONNECTED, METAMASK_ERROR_USER_REJECTED_REQUEST, ERROR_INTERCEPTOR_DISABLED, NEW_BLOCK_ABORT } from '../utils/constants.js'
import { clearWebsiteConnectionIntent, hasAccess as getWebsiteAccessApprovalState, hasAddressAccess as getWebsiteAddressAccessApprovalState, persistWebsiteAccessChange, sendActiveAccountChangeToApprovedWebsitePorts, sendMessageToApprovedWebsitePorts, sendProviderConnectionEventsToPort, updateWebsiteApprovalAccesses, verifyAccess, withSuppressedUnscopedConnectionEventsForSocket } from './accessManagement.js'
import { getActiveAddressEntry, identifyAddress } from './metadataUtils.js'
import { getActiveAddress, sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { assertNever, assertUnreachable } from '../utils/typescript.js'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { appendTransactionsToInput, mockSignTransaction } from '../simulation/services/SimulationModeEthereumClientService.js'
import { Semaphore } from '../utils/semaphore.js'
import { JsonRpcResponseError, reportUnexpectedError, isExpectedInfrastructureError, isFailedToFetchError, isNewBlockAbort } from '../utils/errors.js'
import { InterceptedRequest, type UniqueRequestIdentifier, type WebsiteSocket } from '../utils/requests.js'
import { getSimulationStackTargetHash } from '../utils/simulationStackTargets.js'
import { replyToInterceptedRequest } from './messageSending.js'
import { bumpPopupRefreshGeneration } from './popupRefreshGeneration.js'
import { type EthGetStorageAtParams, EthereumJsonRpcRequest, type SendRawTransactionParams, type SendTransactionParams, SupportedEthereumJsonRpcRequestMethods, type WalletAddEthereumChain, WalletRevokePermissions } from '../types/JsonRpc-types.js'
import type { Website } from '../types/websiteAccessTypes.js'
import type { ConfirmTransactionTransactionSingleVisualization } from '../types/accessRequest.js'
import type { RpcNetwork } from '../types/rpc.js'
import { serialize } from '../types/wire-types.js'
import { last } from '../utils/array.js'
import { connectedToSigner, ethAccountsReply, signerChainChanged, signerReply, walletSwitchEthereumChainReply } from './providerMessageHandlers.js'
import { makeSureInterceptorIsNotSleeping } from './sleeping.js'
import type { PublishRpcConnectionStatus } from './rpcSlowRequestTracking.js'
import { decodeEthereumError } from '../utils/errorDecoding.js'
import { buildExecutionSimulationStateFromPreparedInput, buildSimulationStateFromPreparedInput, createSimulationStateWithNonceAndBaseFeeFixing, getCurrentSimulationInput, prepareSimulationInputForRpc, visualizeSimulatorState } from './simulationUpdating.js'
import { PopupReplyOption } from '../types/interceptor-reply-messages.js'
import { updatePopupVisualisationIfNeeded } from './popupVisualisationUpdater.js'
import type { TokenPriceService } from '../simulation/services/priceEstimator.js'
import type { ResetSimulationServices } from '../simulation/serviceLifecycle.js'
import { isAccountConnectionMethod, isAccountOnlyMethod } from './accountRequestMethods.js'
import type { ErrorWithCodeAndOptionalData } from '../types/error.js'
import { getActiveAddressForCurrentSignerState, getConfirmedSignerStateToken, isSignerStateTokenCurrent, sendCallbackToConfirmedSignerOwner } from './signerStateOwnership.js'

const simulationAbortController = new AbortController()
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

const getSignedTransactionForSimulation = (transactionToSimulate: WebsiteCreatedEthereumUnsignedTransaction) => (
	transactionToSimulate.signedTransaction ?? mockSignTransaction(transactionToSimulate.transaction)
)

export async function getUpdatedSimulationState(ethereum: EthereumClientService) {
	try {
		return toResolvedSimulationState(await createSimulationStateWithNonceAndBaseFeeFixing(await getCurrentSimulationInput(), ethereum))
	} catch(error: unknown) {
		if (isExpectedInfrastructureError(error)) return PASSTHROUGH_STATE
		await reportUnexpectedError(error, { code: 'simulation_state_refresh_failed' })
	}
	return PASSTHROUGH_STATE
}

let confirmTransactionAbortController = new AbortController()
export async function refreshConfirmTransactionSimulation(
	ethereum: EthereumClientService,
	tokenPriceService: TokenPriceService,
	activeAddress: bigint,
	simulationMode: boolean,
	uniqueRequestIdentifier: UniqueRequestIdentifier,
	transactionToSimulate: WebsiteCreatedEthereumUnsignedTransactionOrFailed,
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
				const simulationStateWithNewTransaction = transactionToSimulate.success ? appendTransactionsToInput(simulationInput, [{
				signedTransaction: getSignedTransactionForSimulation(transactionToSimulate),
				website: transactionToSimulate.website,
				created: transactionToSimulate.created,
					originalRequestParameters: transactionToSimulate.originalRequestParameters,
					transactionIdentifier: transactionToSimulate.transactionIdentifier
				}]) : simulationInput
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
		if (!(error instanceof JsonRpcResponseError)) throw error

		const extractToAbi = async () => {
			const params = transactionToSimulate.originalRequestParameters.params[0]
			if (!('to' in params)) return []
			if (params.to === undefined || params.to === null) return []
			const identified = await identifyAddress(ethereum, undefined, params.to)
			if ('abi' in identified && identified.abi !== undefined) return [identified.abi]
			return []
		}
		const baseError = {
			code: error.code,
			message: error.message,
			data: typeof error.data === 'string' ? error.data : '0x',
		}
		return { statusCode: 'failed' as const, data: {
			...info,
			simulationStartedTimestamp,
			error: { ...baseError, decodedErrorMessage: decodeEthereumError(await extractToAbi(), baseError).reason },
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
	getSimulationState: () => Promise<ResolvedSimulationState>,
	websiteTabConnections: WebsiteTabConnections,
	socket: WebsiteSocket,
	website: Website,
	request: InterceptedRequest,
	settings: Settings,
	activeAddress: bigint | undefined,
	publishRpcConnectionStatus: PublishRpcConnectionStatus,
): Promise<RPCReply> {
	const maybeParsedRequest = EthereumJsonRpcRequest.safeParse(request)
	const forwardToSigner = !settings.simulationMode && !request.usingInterceptorWithoutSigner
	const getForwardingMessage = (request: SendRawTransactionParams | SendTransactionParams | WalletAddEthereumChain | EthGetStorageAtParams) => {
		if (!forwardToSigner) throw new Error('Should not forward to signer')
		return { type: 'forwardToSigner' as const, ...request }
	}

	if (maybeParsedRequest.success === false) {
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
	const accountOnlyMethod = isAccountOnlyMethod(parsedRequest.method)
	if (settings.activeRpcNetwork.httpsRpc === undefined && forwardToSigner && !accountOnlyMethod) {
		// we are using network that is not supported by us
		return { type: 'forwardToSigner' as const, replyWithSignersReply: true, ...request }
	}
	const withSimulationInput = async (handler: (simulationInput: ResolvedSimulationInput) => Promise<RPCReply>) => await handler(await getSimulationInput())
	const withExecutionSimulationState = async (handler: (simulationState: ResolvedExecutionSimulationState) => Promise<RPCReply>) => await handler(await getExecutionSimulationState())
	const withSimulationState = async (handler: (simulationState: ResolvedSimulationState) => Promise<RPCReply>) => await handler(await getSimulationState())
	if (!accountOnlyMethod) await makeSureInterceptorIsNotSleeping(ethereum, publishRpcConnectionStatus)
	switch (parsedRequest.method) {
		case 'eth_getBlockByHash': return await withSimulationInput((simulationInput) => getBlockByHash(ethereum, simulationInput, parsedRequest))
		case 'eth_getBlockByNumber': return await withSimulationInput((simulationInput) => getBlockByNumber(ethereum, simulationInput, parsedRequest))
		case 'eth_getBalance': return await withSimulationInput((simulationInput) => getBalance(ethereum, simulationInput, parsedRequest))
		case 'eth_estimateGas': return await withSimulationInput((simulationInput) => estimateGas(ethereum, simulationInput, parsedRequest))
		case 'eth_getTransactionByHash': return await withSimulationInput((simulationInput) => getTransactionByHash(ethereum, simulationInput, parsedRequest))
		case 'eth_getTransactionReceipt': return await withExecutionSimulationState((simulationState) => getTransactionReceipt(ethereum, simulationState, parsedRequest))
		case 'eth_call': return await withSimulationInput((simulationInput) => call(ethereum, simulationInput, parsedRequest))
		case 'eth_blockNumber': return await withSimulationInput((simulationInput) => blockNumber(ethereum, simulationInput))
		case 'eth_subscribe': return await subscribe(socket, parsedRequest)
		case 'eth_unsubscribe': return await unsubscribe(socket, parsedRequest)
		case 'eth_chainId': return await chainId(ethereum)
		case 'net_version': return await netVersion(ethereum)
		case 'eth_getCode': return await withSimulationInput((simulationInput) => getCode(ethereum, simulationInput, parsedRequest))
		case 'personal_sign':
		case 'eth_signTypedData':
		case 'eth_signTypedData_v1':
		case 'eth_signTypedData_v2':
		case 'eth_signTypedData_v3':
		case 'eth_signTypedData_v4': return await personalSign(ethereum, tokenPriceService, activeAddress, parsedRequest, request, website, websiteTabConnections, !forwardToSigner)
		case 'wallet_switchEthereumChain': return await switchEthereumChain(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, parsedRequest, request, settings.simulationMode, website)
		case 'wallet_requestPermissions': return await requestPermissions(activeAddress, website)
		case 'wallet_getPermissions': return await getPermissions(activeAddress, website)
		case 'eth_accounts': return await getAccounts(activeAddress)
		case 'eth_requestAccounts': return await getAccounts(activeAddress)
		case 'eth_gasPrice': return await gasPrice(ethereum)
		case 'eth_getTransactionCount': return await withSimulationInput((simulationInput) => getTransactionCount(ethereum, simulationInput, parsedRequest))
		case 'interceptor_getSimulationStack': return await withSimulationState((simulationState) => requestInterceptorSimulatorStack(simulationState, websiteTabConnections, parsedRequest, website, request, socket))
		case 'eth_simulateV1': return await withSimulationInput((simulationInput) => ethSimulateV1(ethereum, simulationInput, parsedRequest))
		case 'wallet_addEthereumChain': {
			if (forwardToSigner) return getForwardingMessage(parsedRequest)
			return { type: 'result' as const, method: parsedRequest.method, error: { code: 10000, message: 'wallet_addEthereumChain not implemented' } }
		}
		case 'eth_getStorageAt': {
			if (forwardToSigner) return getForwardingMessage(parsedRequest)
			return { type: 'result' as const, method: parsedRequest.method, error: { code: 10000, message: 'eth_getStorageAt not implemented' } }
		}
		case 'eth_getLogs': return await withExecutionSimulationState((simulationState) => getLogs(ethereum, simulationState, parsedRequest))
		case 'eth_sign': return { type: 'result' as const,method: parsedRequest.method, error: { code: 10000, message: 'eth_sign is deprecated' } }
		case 'eth_sendRawTransaction':
		case 'eth_sendTransaction': {
			if (forwardToSigner && settings.activeRpcNetwork.httpsRpc === undefined) return getForwardingMessage(parsedRequest)
			return await sendTransaction(ethereum, tokenPriceService, activeAddress, parsedRequest, request, website, websiteTabConnections, !forwardToSigner)
		}
		case 'web3_clientVersion': return await web3ClientVersion(ethereum)
		case 'eth_feeHistory': return await feeHistory(ethereum, parsedRequest)
		case 'eth_newFilter': return await withSimulationInput((simulationInput) => installNewFilter(socket, parsedRequest, ethereum, simulationInput))
		case 'eth_uninstallFilter': return await uninstallNewFilter(socket, parsedRequest)
		case 'eth_getFilterChanges': return await withExecutionSimulationState((simulationState) => getFilterChanges(parsedRequest, ethereum, simulationState))
		case 'eth_getFilterLogs': return await withExecutionSimulationState((simulationState) => getFilterLogs(parsedRequest, ethereum, simulationState))
		case 'InterceptorError': return await handleIterceptorError(parsedRequest)
		/*
		Missing methods:
		case 'eth_getProof': return
		case 'eth_getBlockTransactionCountByNumber': return
		case 'eth_getTransactionByBlockHashAndIndex': return
		case 'eth_getTransactionByBlockNumberAndIndex': return
		case 'eth_getBlockReceipts': return

		case 'eth_newBlockFilter': return
		case 'eth_newPendingTransactionFilter': return

		case 'eth_protocolVersion': return
		case 'eth_maxPriorityFeePerGas': return
		case 'net_listening': return

		case 'eth_getUncleByBlockHashAndIndex': return
		case 'eth_getUncleByBlockNumberAndIndex': return
		case 'eth_getUncleCountByBlockHash': return
		case 'eth_getUncleCountByBlockNumber': return
		*/
	}
}

export async function resetSimulationStateFromConfig(ethereum: EthereumClientService, tokenPriceService: TokenPriceService) {
	await updateInterceptorTransactionStack(() => ({ operations: [] }))
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
		await changeSimulationMode({
			simulationMode: change.simulationMode,
			...('activeAddress' in change ? { activeSigningAddress: change.activeAddress } : {}),
			...(change.rpcNetwork !== undefined ? { rpcNetwork: change.rpcNetwork } : {}),
		})
	}

	const updatedSettings = await getSettings()
	const popupRefreshGeneration = await updateWebsiteApprovalAccesses(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, updatedSettings, true)
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

function getProviderHandler(method: string) {
	switch (method) {
		case 'signer_reply': return { method: 'signer_reply' as const, func: signerReply }
		case 'eth_accounts_reply': return { method: 'eth_accounts_reply' as const, func: ethAccountsReply }
		case 'signer_chainChanged': return { method: 'signer_chainChanged' as const, func: signerChainChanged }
		case 'wallet_switchEthereumChain_reply': return { method: 'wallet_switchEthereumChain_reply' as const, func: walletSwitchEthereumChainReply }
		case 'connected_to_signer': return { method: 'connected_to_signer' as const, func: connectedToSigner }
		default: return { method: 'notProviderMethod' as const }
	}
}

function replyWithEmptyAccounts(websiteTabConnections: WebsiteTabConnections, request: InterceptedRequest) {
	return replyToInterceptedRequest(websiteTabConnections, { type: 'result', method: 'eth_accounts' as const, result: [], uniqueRequestIdentifier: request.uniqueRequestIdentifier })
}

function replyWithEmptyPermissions(websiteTabConnections: WebsiteTabConnections, request: InterceptedRequest) {
	return replyToInterceptedRequest(websiteTabConnections, { type: 'result', method: 'wallet_getPermissions' as const, result: [], uniqueRequestIdentifier: request.uniqueRequestIdentifier })
}

function replyWithEmptyAccountIdentity(websiteTabConnections: WebsiteTabConnections, request: InterceptedRequest) {
	switch (request.method) {
		case 'eth_accounts': return replyWithEmptyAccounts(websiteTabConnections, request)
		case 'wallet_getPermissions': return replyWithEmptyPermissions(websiteTabConnections, request)
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

function replayProviderStateForAccountRequest(websiteTabConnections: WebsiteTabConnections, request: InterceptedRequest, settings: Settings, resolved: RPCReply, activeAddress: bigint | undefined) {
	const accounts = getApprovedAccountsForAccountRequest(request, resolved, activeAddress)
	if (accounts === undefined || accounts.length === 0) return
	sendProviderConnectionEventsToPort(websiteTabConnections, request.uniqueRequestIdentifier.requestSocket, settings, accounts, { requestId: request.uniqueRequestIdentifier.requestId, includeChainChanged: false })
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
): Promise<Settings | undefined> {
	const accounts = getApprovedAccountsForAccountRequest(request, resolved, activeAddress)
	if (accounts === undefined || accounts.length === 0) return undefined

	const settings = await getSettings()
	let storedAddressAccess = false
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
		storedAddressAccess = true
	}

	if (!storedAddressAccess) return settings
	return await getSettings()
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
	await updateWebsiteApprovalAccesses(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, await getSettings(), false)
	await sendPopupMessageToOpenWindows({ method: 'popup_websiteAccess_changed' })
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
	if (activeAddress !== undefined) return { settings, activeAddress, requestedSignerAccountsForSiteAccess: false, signerAccountError: undefined }
	if (!isAccountConnectionMethod(request.method)) return { settings, activeAddress, requestedSignerAccountsForSiteAccess: false, signerAccountError: undefined }
	if (getWebsiteAccessApprovalState(settings.websiteAccess, websiteOrigin) !== 'hasAccess') return { settings, activeAddress, requestedSignerAccountsForSiteAccess: false, signerAccountError: undefined }

	const signerAccountsResult = await askForSignerAccountsFromSignerIfNotAvailable(websiteTabConnections, socket, true)
	const refreshedSettings = await getSettings()
	const refreshedActiveAddress = await getActiveAddressForRequest(refreshedSettings, websiteTabConnections, socket.tabId)
	if (refreshedActiveAddress !== undefined) return { settings: refreshedSettings, activeAddress: refreshedActiveAddress, requestedSignerAccountsForSiteAccess: true, signerAccountError: signerAccountsResult.error }
	const firstSignerAddress = signerAccountsResult.accounts[0] === undefined ? undefined : await getActiveAddressEntry(signerAccountsResult.accounts[0])
	return { settings: refreshedSettings, activeAddress: firstSignerAddress, requestedSignerAccountsForSiteAccess: true, signerAccountError: signerAccountsResult.error }
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
	const { settings, activeAddress, requestedSignerAccountsForSiteAccess, signerAccountError } = await discoverAccountRequestAddressContext(websiteTabConnections, socket, request, websiteOrigin)
	if (isTerminalSignerAccountConnectionError(signerAccountError)) return replyWithSignerAccountError(websiteTabConnections, request, signerAccountError)
	if (requestedSignerAccountsForSiteAccess && activeAddress === undefined) {
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
		accountIdentityRequest,
	)
	const access = accountConnectionRequest ? withSuppressedUnscopedConnectionEventsForSocket(socket, verifyRequestAccess) : verifyRequestAccess()
	if (access === 'interceptorDisabled') return replyToInterceptedRequest(websiteTabConnections, { type: 'result', ...getRequestWithDefinedParams(request), ...ERROR_INTERCEPTOR_DISABLED })
	if (access === 'hasAccess' && activeAddress === undefined && accountConnectionRequest) {
		// user has granted access to the site, but not to this account and the application is requesting accounts
		if (requestedSignerAccountsForSiteAccess) return refuseAccess(websiteTabConnections, request)
		const signerAccountsResult = await askForSignerAccountsFromSignerIfNotAvailable(websiteTabConnections, socket, true)
		if (isTerminalSignerAccountConnectionError(signerAccountsResult.error)) return replyWithSignerAccountError(websiteTabConnections, request, signerAccountsResult.error)
		if (signerAccountsResult.accounts.length === 0) return refuseAccess(websiteTabConnections, request)
		const result: unknown = await handleInterceptedRequest(port, websiteOrigin, websitePromise, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections, publishRpcConnectionStatus)
		return result
	}
	if (access === 'hasAccess' && activeAddress === undefined && (request.method === 'eth_accounts' || request.method === 'wallet_getPermissions') && (!settings.simulationMode || settings.useSignersAddressAsActiveAddress)) {
		const signerAccountsResult = await askForSignerAccountsFromSignerIfNotAvailable(websiteTabConnections, socket, false)
		if (isSignerProviderDisconnectedError(signerAccountsResult.error)) return replyWithSignerAccountError(websiteTabConnections, request, signerAccountsResult.error)
		const signerAccounts = signerAccountsResult.accounts
		if (signerAccounts.length === 0) return replyWithEmptyAccountIdentity(websiteTabConnections, request)
		const firstSignerAccount = signerAccounts[0]
		if (firstSignerAccount === undefined) return replyWithEmptyAccountIdentity(websiteTabConnections, request)
		const refreshedSettings = await getSettings()
		let refreshedActiveAddress = await getActiveAddressForRequest(refreshedSettings, websiteTabConnections, socket.tabId)
		if (refreshedActiveAddress === undefined) {
			const signerStateToken = getConfirmedSignerStateToken(websiteTabConnections, socket.tabId)
			if (signerStateToken !== undefined) {
				const firstSignerAddress = await getActiveAddressEntry(firstSignerAccount)
				if (isSignerStateTokenCurrent(websiteTabConnections, signerStateToken)) refreshedActiveAddress = firstSignerAddress
			}
		}
		if (refreshedActiveAddress === undefined) return replyWithEmptyAccountIdentity(websiteTabConnections, request)
		const refreshedAccess = verifyAccess(websiteTabConnections, socket, false, websiteOrigin, refreshedActiveAddress, refreshedSettings, true)
		if (refreshedAccess !== 'hasAccess') return replyWithEmptyAccountIdentity(websiteTabConnections, request)
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
			return await handleContentScriptMessage(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, request, await websitePromise, activeAddress?.address, publishRpcConnectionStatus)
		}
		default: assertNever(access)
	}
}

async function handleContentScriptMessage(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, resetSimulationServices: ResetSimulationServices, websiteTabConnections: WebsiteTabConnections, request: InterceptedRequest, website: Website, activeAddress: bigint | undefined, publishRpcConnectionStatus: PublishRpcConnectionStatus) {
	try {
		const requestWithDefinedParams = getRequestWithDefinedParams(request)
		const settings = await getSettings()
		let simulationInputPromise: Promise<ResolvedSimulationInput> | undefined
		let executionSimulationStatePromise: Promise<ResolvedExecutionSimulationState> | undefined
		let simulationStatePromise: Promise<ResolvedSimulationState> | undefined
		const getSimulationInput = async () => {
			if (!settings.simulationMode) return PASSTHROUGH_STATE
			if (simulationInputPromise === undefined) simulationInputPromise = (async () => toResolvedSimulationInput(await prepareSimulationInputForRpc(await getCurrentSimulationInput(), ethereum)))()
			return await simulationInputPromise
		}
		const getExecutionSimulationState = async () => {
			if (!settings.simulationMode) return PASSTHROUGH_STATE
			if (executionSimulationStatePromise === undefined) executionSimulationStatePromise = (async () => {
				const simulationInput = await getSimulationInput()
				if (simulationInput.kind === 'passthrough') return PASSTHROUGH_STATE
				return toResolvedExecutionSimulationState(await buildExecutionSimulationStateFromPreparedInput(simulationInput.value, ethereum))
			})()
			return await executionSimulationStatePromise
		}
		const getSimulationState = async () => {
			if (!settings.simulationMode) return PASSTHROUGH_STATE
			if (simulationStatePromise === undefined) simulationStatePromise = (async () => {
				const simulationInput = await getSimulationInput()
				if (simulationInput.kind === 'passthrough') return PASSTHROUGH_STATE
				return toResolvedSimulationState(await buildSimulationStateFromPreparedInput(simulationInput.value, ethereum))
			})()
			return await simulationStatePromise
		}
		const resolved = await handleRPCRequest(ethereum, tokenPriceService, resetSimulationServices, getSimulationInput, getExecutionSimulationState, getSimulationState, websiteTabConnections, request.uniqueRequestIdentifier.requestSocket, website, request, settings, activeAddress, publishRpcConnectionStatus)
		const refreshedSettings = await persistApprovedAccountsForAccountRequest(
			ethereum,
			tokenPriceService,
			resetSimulationServices,
			websiteTabConnections,
			request,
			website,
			resolved,
			activeAddress,
		)
		replayProviderStateForAccountRequest(websiteTabConnections, request, refreshedSettings ?? settings, resolved, activeAddress)
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
		const processRequest = async (): Promise<PopupReplyOption | void> => {
			switch (parsedRequest.method) {
				case 'popup_confirmDialog': return await confirmDialog(ethereum, tokenPriceService, websiteTabConnections, parsedRequest)
				case 'popup_changeActiveAddress': return await changeActiveAddress(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, parsedRequest)
				case 'popup_modifyMakeMeRich': return await modifyMakeMeRich(parsedRequest)
				case 'popup_changePage': return await changePage(parsedRequest)
				case 'popup_requestAccountsFromSigner': return await requestAccountsFromSigner(websiteTabConnections, parsedRequest)
				case 'popup_resetSimulation': return await resetSimulationStateFromConfig(ethereum, tokenPriceService)
				case 'popup_removeTransactionOrSignedMessage': return await removeTransactionOrSignedMessage(ethereum, tokenPriceService, parsedRequest)
				case 'popup_refreshSimulation': {
					await updatePopupVisualisationIfNeeded(ethereum, tokenPriceService, false, false, true)
					return
				}
				case 'popup_refreshConfirmTransactionDialogSimulation': return await refreshPopupConfirmTransactionSimulation(ethereum, tokenPriceService)
				case 'popup_refreshConfirmTransactionMetadata': return refreshPopupConfirmTransactionMetadata(ethereum, tokenPriceService, confirmTransactionAbortController)
				case 'popup_interceptorAccess': return await confirmRequestAccess(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, parsedRequest, publishRpcConnectionStatus)
				case 'popup_changeInterceptorAccess': return await changeInterceptorAccess(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, parsedRequest)
				case 'popup_changeActiveRpc': return await popupChangeActiveRpc(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, parsedRequest, settings)
				case 'popup_changeChainDialog': return await changeChainDialog(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, parsedRequest)
				case 'popup_enableSimulationMode': return await enableSimulationMode(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, parsedRequest)
				case 'popup_addOrModifyAddressBookEntry': return await addOrModifyAddressBookEntry(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, parsedRequest)
				case 'popup_getAddressBookData': return await getAddressBookData(parsedRequest)
				case 'popup_removeAddressBookEntry': return await removeAddressBookEntry(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, parsedRequest)
				case 'popup_openAddressBook': return await openNewTab('addressBook')
				case 'popup_requestNewHomeData': return await requestNewHomeData(ethereum, websiteTabConnections, parsedRequest.data.refreshSignerAccounts, parsedRequest.data.includeWebsiteAccessAddressMetadata, simulationAbortController, bumpPopupRefreshGeneration())
				case 'popup_requestHomePageBootstrap': return await requestHomePageBootstrap(websiteTabConnections, bumpPopupRefreshGeneration())
				case 'popup_refreshHomeData': return await refreshHomeData(ethereum, tokenPriceService, websiteTabConnections, true, bumpPopupRefreshGeneration(), publishRpcConnectionStatus)
				case 'popup_requestSettings': return await settingsOpened()
				case 'popup_refreshInterceptorAccessMetadata': return await interceptorAccessMetadataRefresh()
				case 'popup_interceptorAccessChangeAddress': return await interceptorAccessChangeAddressOrRefresh(websiteTabConnections, parsedRequest)
				case 'popup_interceptorAccessRefresh': return await interceptorAccessChangeAddressOrRefresh(websiteTabConnections, parsedRequest)
				case 'popup_ChangeSettings': return await changeSettings(ethereum, tokenPriceService, resetSimulationServices, parsedRequest, simulationAbortController)
				case 'popup_openSettings': return await openNewTab('settingsView')
				case 'popup_import_settings': {
					const importSettingsReply = await importSettings(parsedRequest)
					await sendPopupMessageToOpenWindows(importSettingsReply)
					if (!importSettingsReply.data.success) return
					const settings = await getSettings()
					const popupRefreshGeneration = await updateWebsiteApprovalAccesses(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, settings, true)
					await sendPopupMessageToOpenWindows({ method: 'popup_settingsUpdated', data: settings, popupRefreshGeneration })
					return
				}
				case 'popup_get_export_settings': return await exportSettings()
				case 'popup_set_rpc_list': return await setNewRpcList(resetSimulationServices, parsedRequest, settings)
				case 'popup_simulateGovernanceContractExecution': return await simulateGovernanceContractExecutionOnPass(ethereum, tokenPriceService, parsedRequest)
				case 'popup_simulateGnosisSafeTransaction': return await simulateGnosisSafeTransactionOnPass(ethereum, tokenPriceService, parsedRequest.data.gnosisSafeMessage)
				case 'popup_changeAddOrModifyAddressWindowState': return await changeAddOrModifyAddressWindowState(ethereum, parsedRequest)
				case 'popup_requestAbiAndNameFromBlockExplorer': return await requestAbiAndNameFromBlockExplorer(parsedRequest)
				case 'popup_openWebPage': return await openWebPage(parsedRequest)
				case 'popup_setDisableInterceptor': return await disableInterceptor(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, parsedRequest)
				case 'popup_clearUnexpectedError': return await setLatestUnexpectedError(undefined)
				case 'popup_setEnsNameForHash': return await setEnsNameForHash(parsedRequest)
				case 'popup_openWebsiteAccess': return await openNewTab('websiteAccess')
				case 'popup_openSimulationStack': return await openNewTab('simulationStack', 'data' in parsedRequest ? getSimulationStackTargetHash(parsedRequest.data) : undefined)
				case 'popup_retrieveWebsiteAccess': return await retrieveWebsiteAccess(parsedRequest)
				case 'popup_blockOrAllowExternalRequests': return await blockOrAllowExternalRequests(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, parsedRequest)
				case 'popup_allowOrPreventAddressAccessForWebsite': return await allowOrPreventAddressAccessForWebsite(websiteTabConnections, parsedRequest)
				case 'popup_removeWebsiteAccess': return await removeWebsiteAccess(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, parsedRequest)
				case 'popup_removeWebsiteAddressAccess': return await removeWebsiteAddressAccess(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, parsedRequest)
				case 'popup_forceSetGasLimitForTransaction': return await forceSetGasLimitForTransaction(ethereum, tokenPriceService, parsedRequest)
				case 'popup_changePreSimulationBlockTimeManipulation': return await changePreSimulationBlockTimeManipulation(ethereum, tokenPriceService, parsedRequest)
				case 'popup_setTransactionOrMessageBlockTimeManipulator': return await setTransactionOrMessageBlockTimeManipulator(ethereum, tokenPriceService, parsedRequest)
				case 'popup_requestMakeMeRichData': return await requestMakeMeRichList(ethereum, simulationAbortController)
				case 'popup_requestActiveAddresses': return await requestActiveAddresses()
				case 'popup_requestSimulationMode': return await requestSimulationMode()
				case 'popup_requestLatestUnexpectedError': return await requestLatestUnexpectedError()
				case 'popup_fetchSimulationStackRequestConfirmation': return await fetchSimulationStackRequestConfirmation(ethereum, websiteTabConnections, parsedRequest)
				case 'popup_readyAndListening': return await popupReadyAndListening(ethereum, parsedRequest.data.page)
				case 'popup_UnexpectedErrorOccured': return await reportUnexpectedErrorInWindow(parsedRequest)
				case 'popup_requestInterceptorSimulationInput': return await requestInterceptorSimulationInput(ethereum)
				case 'popup_importSimulationStack': return await importSimulationStack(ethereum, tokenPriceService, parsedRequest)
				case 'popup_requestCompleteVisualizedSimulation': return await requestCompleteVisualizedSimulation(ethereum, tokenPriceService)
				case 'popup_requestSimulationMetadata': return await requestSimulationMetadata(ethereum)
				case 'popup_requestIdentifyAddress': return await requestIdentifyAddress(ethereum, parsedRequest)
				case 'popup_isMainPopupWindowOpen': return
				case 'popup_isSimulationVisualizerOpen': return
				default: assertUnreachable(parsedRequest)
			}
		}
		const requestReply = await processRequest()
		if (requestReply === undefined) return undefined
		return PopupReplyOption.serialize(requestReply)
	} catch(error: unknown) {
		if (isExpectedInfrastructureError(error)) return
		throw error
	}
}
