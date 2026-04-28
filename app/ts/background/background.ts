import { InpageScriptRequest, PopupMessage, RPCReply, Settings } from '../types/interceptor-messages.js'
import 'webextension-polyfill'
import { getTabState, promoteRpcAsPrimary, setLatestUnexpectedError, updateInterceptorTransactionStack } from './storageVariables.js'
import { changeSimulationMode, getFixedAddressRichList, getSettings, setFixedMakeMeRichList } from './settings.js'
import { blockNumber, call, chainId, estimateGas, gasPrice, getAccounts, getBalance, getBlockByNumber, getCode, getLogs, getPermissions, getTransactionByHash, getTransactionCount, getTransactionReceipt, netVersion, personalSign, sendTransaction, subscribe, switchEthereumChain, unsubscribe, web3ClientVersion, getBlockByHash, feeHistory, installNewFilter, uninstallNewFilter, getFilterChanges, getFilterLogs, handleIterceptorError, requestInterceptorSimulatorStack } from './simulationModeHanders.js'
import { changeActiveAddress, changePage, confirmDialog, removeTransactionOrSignedMessage, requestAccountsFromSigner, refreshPopupConfirmTransactionSimulation, confirmRequestAccess, changeInterceptorAccess, changeChainDialog, popupChangeActiveRpc, enableSimulationMode, addOrModifyAddressBookEntry, getAddressBookData, removeAddressBookEntry, refreshHomeData, interceptorAccessChangeAddressOrRefresh, refreshPopupConfirmTransactionMetadata, changeSettings, importSettings, exportSettings, setNewRpcList, simulateGovernanceContractExecutionOnPass, openNewTab, settingsOpened, changeAddOrModifyAddressWindowState, requestAbiAndNameFromBlockExplorer, openWebPage, disableInterceptor, requestNewHomeData, setEnsNameForHash, simulateGnosisSafeTransactionOnPass, retrieveWebsiteAccess, blockOrAllowExternalRequests, removeWebsiteAccess, allowOrPreventAddressAccessForWebsite, removeWebsiteAddressAccess, forceSetGasLimitForTransaction, changePreSimulationBlockTimeManipulation, setTransactionOrMessageBlockTimeManipulator, modifyMakeMeRich, requestMakeMeRichList, requestActiveAddresses, requestSimulationMode, requestLatestUnexpectedError, fetchSimulationStackRequestConfirmation, handleUnexpectedErrorInWindow, requestInterceptorSimulationInput, importSimulationStack, requestCompleteVisualizedSimulation, requestSimulationMetadata, requestIdentifyAddress, popupReadyAndListening } from './popupMessageHandlers.js'
import { SimulationState, SimulationStateInput, WebsiteCreatedEthereumUnsignedTransactionOrFailed } from '../types/visualizer-types.js'
import { WebsiteTabConnections } from '../types/user-interface-types.js'
import { askForSignerAccountsFromSignerIfNotAvailable, interceptorAccessMetadataRefresh, requestAccessFromUser } from './windows/interceptorAccess.js'
import { METAMASK_ERROR_FAILED_TO_PARSE_REQUEST, METAMASK_ERROR_NOT_AUTHORIZED, METAMASK_ERROR_NOT_CONNECTED_TO_CHAIN, ERROR_INTERCEPTOR_DISABLED, NEW_BLOCK_ABORT } from '../utils/constants.js'
import { sendActiveAccountChangeToApprovedWebsitePorts, sendMessageToApprovedWebsitePorts, updateWebsiteApprovalAccesses, verifyAccess } from './accessManagement.js'
import { getActiveAddressEntry, identifyAddress } from './metadataUtils.js'
import { getActiveAddress, sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { assertNever, assertUnreachable } from '../utils/typescript.js'
import { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { appendTransactionsToInput, mockSignTransaction, type ExecutionSimulationState } from '../simulation/services/SimulationModeEthereumClientService.js'
import { Semaphore } from '../utils/semaphore.js'
import { JsonRpcResponseError, handleUnexpectedError, isFailedToFetchError, isNewBlockAbort, printError } from '../utils/errors.js'
import { InterceptedRequest, UniqueRequestIdentifier, WebsiteSocket } from '../utils/requests.js'
import { replyToInterceptedRequest } from './messageSending.js'
import { EthGetStorageAtParams, EthereumJsonRpcRequest, SendRawTransactionParams, SendTransactionParams, SupportedEthereumJsonRpcRequestMethods, WalletAddEthereumChain } from '../types/JsonRpc-types.js'
import { Website } from '../types/websiteAccessTypes.js'
import { ConfirmTransactionTransactionSingleVisualization } from '../types/accessRequest.js'
import { RpcNetwork } from '../types/rpc.js'
import { serialize } from '../types/wire-types.js'
import { Interface } from 'ethers'
import { connectedToSigner, ethAccountsReply, signerChainChanged, signerReply, walletSwitchEthereumChainReply } from './providerMessageHandlers.js'
import { makeSureInterceptorIsNotSleeping } from './sleeping.js'
import { decodeEthereumError } from '../utils/errorDecoding.js'
import { buildExecutionSimulationStateFromPreparedInput, buildSimulationStateFromPreparedInput, createSimulationStateWithNonceAndBaseFeeFixing, getCurrentSimulationInput, prepareSimulationInputForRpc, visualizeSimulatorState } from './simulationUpdating.js'
import { PopupReplyOption } from '../types/interceptor-reply-messages.js'
import { updatePopupVisualisationIfNeeded } from './popupVisualisationUpdater.js'
import { TokenPriceService } from '../simulation/services/priceEstimator.js'
import { ResetSimulationServices } from '../simulation/serviceLifecycle.js'

let simulationAbortController = new AbortController()

export async function getUpdatedSimulationState(ethereum: EthereumClientService) {
	try {
		return await createSimulationStateWithNonceAndBaseFeeFixing(await getCurrentSimulationInput(), ethereum)
	} catch(error: unknown) {
		if (error instanceof Error && (isNewBlockAbort(error) || isFailedToFetchError(error))) return
		printError(error)
	}
	return undefined
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
				signedTransaction: mockSignTransaction(transactionToSimulate.transaction),
				website: transactionToSimulate.website,
				created: transactionToSimulate.created,
					originalRequestParameters: transactionToSimulate.originalRequestParameters,
					transactionIdentifier: transactionToSimulate.transactionIdentifier
				}]) : simulationInput
				const updatedSimulationState = await createSimulationStateWithNonceAndBaseFeeFixing(simulationStateWithNewTransaction, ethereum)
				return await visualizeSimulatorState(updatedSimulationState, ethereum, tokenPriceService, thisConfirmTransactionAbortController)
		}
		const visualizedSimulatorState = await getNewVisualizedSimulationState()
		const availableAbis = visualizedSimulatorState.addressBookEntries.map((entry) => 'abi' in entry && entry.abi !== undefined ? new Interface(entry.abi) : undefined).filter((abiOrUndefined): abiOrUndefined is Interface => abiOrUndefined !== undefined)
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
		const lastTransaction = blocks.at(-1)?.simulatedAndVisualizedTransactions.at(-1)
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
		if (error instanceof Error && isNewBlockAbort(error)) return undefined
		if (error instanceof Error && isFailedToFetchError(error)) return undefined
		if (!(error instanceof JsonRpcResponseError)) throw error

			const extractToAbi = async () => {
				const params = transactionToSimulate.originalRequestParameters.params[0]
				if (!('to' in params)) return []
				if (params.to === undefined || params.to === null) return []
				const identified = await identifyAddress(ethereum, undefined, params.to)
				if ('abi' in identified && identified.abi !== undefined) return [new Interface(identified.abi)]
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
	getSimulationInput: () => Promise<SimulationStateInput | undefined>,
	getExecutionSimulationState: () => Promise<ExecutionSimulationState | undefined>,
	getSimulationState: () => Promise<SimulationState | undefined>,
	websiteTabConnections: WebsiteTabConnections,
	socket: WebsiteSocket,
	website: Website,
	request: InterceptedRequest,
	settings: Settings,
	activeAddress: bigint | undefined,
): Promise<RPCReply> {
	const maybeParsedRequest = EthereumJsonRpcRequest.safeParse(request)
	const forwardToSigner = !settings.simulationMode && !request.usingInterceptorWithoutSigner
	const getForwardingMessage = (request: SendRawTransactionParams | SendTransactionParams | WalletAddEthereumChain | EthGetStorageAtParams) => {
		if (!forwardToSigner) throw new Error('Should not forward to signer')
		return { type: 'forwardToSigner' as const, ...request }
	}

	if (maybeParsedRequest.success === false) {
		// biome-ignore lint/suspicious/noConsoleLog: <Used for support debugging>
		console.log({ request })
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
	if (settings.activeRpcNetwork.httpsRpc === undefined && forwardToSigner) {
		// we are using network that is not supported by us
		return { type: 'forwardToSigner' as const, replyWithSignersReply: true, ...request }
	}
	const parsedRequest = maybeParsedRequest.value
	const withSimulationInput = async (handler: (simulationInput: SimulationStateInput | undefined) => Promise<RPCReply>) => await handler(await getSimulationInput())
	const withExecutionSimulationState = async (handler: (simulationState: ExecutionSimulationState | undefined) => Promise<RPCReply>) => await handler(await getExecutionSimulationState())
	const withSimulationState = async (handler: (simulationState: SimulationState | undefined) => Promise<RPCReply>) => await handler(await getSimulationState())
	makeSureInterceptorIsNotSleeping(ethereum)
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
		case 'wallet_requestPermissions': return await getAccounts(activeAddress)
		case 'wallet_getPermissions': return await getPermissions()
		case 'eth_accounts': return await getAccounts(activeAddress)
		case 'eth_requestAccounts': return await getAccounts(activeAddress)
		case 'eth_gasPrice': return await gasPrice(ethereum)
		case 'eth_getTransactionCount': return await withSimulationInput((simulationInput) => getTransactionCount(ethereum, simulationInput, parsedRequest))
		case 'interceptor_getSimulationStack': return await withSimulationState((simulationState) => requestInterceptorSimulatorStack(simulationState, websiteTabConnections, parsedRequest, website, request, socket))
		case 'eth_simulateV1': return { type: 'result', method: parsedRequest.method, error: { code: 10000, message: 'Cannot call eth_simulateV1 directly' } }
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
	const richList = (await getFixedAddressRichList()).filter((element) => !(element.type === 'PreviousActiveAddress' && !element.makingRich)).map((element) => ({ ...element, type: 'UserAdded' as const }))
	const previousActiveAddress = (await getSettings()).activeSimulationAddress
	if (previousActiveAddress === undefined || richList.some((element) => element.address === previousActiveAddress)) return await setFixedMakeMeRichList(richList)
	await setFixedMakeMeRichList([...richList, { address: previousActiveAddress, makingRich: false, type: 'PreviousActiveAddress' as const }])
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
	sendPopupMessageToOpenWindows({ method: 'popup_settingsUpdated', data: updatedSettings })
	updateWebsiteApprovalAccesses(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, updatedSettings)
	sendPopupMessageToOpenWindows({ method: 'popup_accounts_update' })
	await changeActiveAddressAndChainSemaphore.execute(async () => {
		if (change.rpcNetwork !== undefined) {
			if (change.rpcNetwork.httpsRpc !== undefined) resetSimulationServices(change.rpcNetwork)
			sendMessageToApprovedWebsitePorts(websiteTabConnections, { method: 'chainChanged' as const, result: change.rpcNetwork.chainId })
			sendPopupMessageToOpenWindows({ method: 'popup_chain_update' })

			// reset simulation if chain id was changed
			if (updatedSettings.simulationMode) await resetSimulationStateFromConfig(ethereum, tokenPriceService)
		}
		// inform website about this only after we have updated simulation, as they often query the balance right after
		sendActiveAccountChangeToApprovedWebsitePorts(websiteTabConnections, await getSettings())
	})
}

export async function changeActiveRpc(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, resetSimulationServices: ResetSimulationServices, websiteTabConnections: WebsiteTabConnections, rpcNetwork: RpcNetwork, simulationMode: boolean) {
	// allow switching RPC only if we are in simulation mode, or that chain id would not change
	if (simulationMode || rpcNetwork.chainId === (await getSettings()).activeRpcNetwork.chainId) return await changeActiveAddressAndChain(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, { simulationMode, rpcNetwork })
	sendMessageToApprovedWebsitePorts(websiteTabConnections, { method: 'request_signer_to_wallet_switchEthereumChain', result: rpcNetwork.chainId })
	await sendPopupMessageToOpenWindows({ method: 'popup_settingsUpdated', data: await getSettings() })
	await promoteRpcAsPrimary(rpcNetwork)
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

function getRequestWithDefinedParams(request: InterceptedRequest) {
	return 'params' in request && request.params !== undefined ? { ...request, params: request.params } : request
}

export const handleInterceptedRequest = async (port: browser.runtime.Port | undefined, websiteOrigin: string, websitePromise: Promise<Website> | Website, ethereum: EthereumClientService, tokenPriceService: TokenPriceService, resetSimulationServices: ResetSimulationServices, socket: WebsiteSocket, request: InterceptedRequest, websiteTabConnections: WebsiteTabConnections): Promise<unknown> => {
	const settings = await getSettings()
	const activeAddress = await getActiveAddress(settings, socket.tabId)
	const access = verifyAccess(websiteTabConnections, socket, request.method === 'eth_requestAccounts' || request.method === 'eth_call', websiteOrigin, activeAddress, settings)
	if (access === 'interceptorDisabled') return replyToInterceptedRequest(websiteTabConnections, { type: 'result', ...getRequestWithDefinedParams(request), ...ERROR_INTERCEPTOR_DISABLED })
	const providerHandler = getProviderHandler(request.method)
	const identifiedMethod = providerHandler.method
	if (identifiedMethod !== 'notProviderMethod') {
		if (port === undefined) return
		const providerHandlerReturn = await providerHandler.func(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, port, request, access, activeAddress?.address)
		if (providerHandlerReturn.type === 'doNotReply') return
		const message: InpageScriptRequest = { uniqueRequestIdentifier: request.uniqueRequestIdentifier, ...providerHandlerReturn }
		return replyToInterceptedRequest(websiteTabConnections, message)
	}
	if (access === 'hasAccess' && activeAddress === undefined && request.method === 'eth_requestAccounts') {
		// user has granted access to the site, but not to this account and the application is requesting accounts
		const account = await askForSignerAccountsFromSignerIfNotAvailable(websiteTabConnections, socket, true)
		if (account.length === 0) return refuseAccess(websiteTabConnections, request)
		const result: unknown = await handleInterceptedRequest(port, websiteOrigin, websitePromise, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections)
		return result
	}
	if (access === 'hasAccess' && activeAddress === undefined && request.method === 'eth_accounts' && (!settings.simulationMode || settings.useSignersAddressAsActiveAddress)) {
		const account = await askForSignerAccountsFromSignerIfNotAvailable(websiteTabConnections, socket, false)
		if (account.length === 0) return replyWithEmptyAccounts(websiteTabConnections, request)
		const result: unknown = await handleInterceptedRequest(port, websiteOrigin, websitePromise, ethereum, tokenPriceService, resetSimulationServices, socket, request, websiteTabConnections)
		return result
	}

	if (access === 'noAccess' || activeAddress === undefined) {
		switch (request.method) {
			case 'eth_accounts': return replyWithEmptyAccounts(websiteTabConnections, request)
			// if user has not given access, assume we are on chain 1
			case 'eth_chainId': return replyToInterceptedRequest(websiteTabConnections, { type: 'result', method: request.method, result: 1n, uniqueRequestIdentifier: request.uniqueRequestIdentifier })
			case 'net_version': return replyToInterceptedRequest(websiteTabConnections, { type: 'result', method: request.method, result: 1n, uniqueRequestIdentifier: request.uniqueRequestIdentifier })
			default: break
		}
	}

	switch (access) {
		case 'askAccess': return await gateKeepRequestBehindAccessDialog(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, socket, request, await websitePromise, activeAddress?.address, await getSettings())
		case 'noAccess': return refuseAccess(websiteTabConnections, request)
		case 'hasAccess': {
			if (activeAddress === undefined) return refuseAccess(websiteTabConnections, request)
			return await handleContentScriptMessage(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, request, await websitePromise, activeAddress?.address)
		}
		default: assertNever(access)
	}
}

async function handleContentScriptMessage(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, resetSimulationServices: ResetSimulationServices, websiteTabConnections: WebsiteTabConnections, request: InterceptedRequest, website: Website, activeAddress: bigint | undefined) {
	try {
		const requestWithDefinedParams = getRequestWithDefinedParams(request)
		const settings = await getSettings()
		let simulationInputPromise: Promise<SimulationStateInput | undefined> | undefined = undefined
		let executionSimulationStatePromise: Promise<ExecutionSimulationState | undefined> | undefined = undefined
		let simulationStatePromise: Promise<SimulationState | undefined> | undefined = undefined
		const getSimulationInput = async () => {
			if (!settings.simulationMode) return undefined
			if (simulationInputPromise === undefined) simulationInputPromise = (async () => await prepareSimulationInputForRpc(await getCurrentSimulationInput(), ethereum))()
			return await simulationInputPromise
		}
		const getExecutionSimulationState = async () => {
			if (!settings.simulationMode) return undefined
			if (executionSimulationStatePromise === undefined) executionSimulationStatePromise = (async () => {
				const simulationInput = await getSimulationInput()
				if (simulationInput === undefined) return undefined
				return await buildExecutionSimulationStateFromPreparedInput(simulationInput, ethereum)
			})()
			return await executionSimulationStatePromise
		}
		const getSimulationState = async () => {
			if (!settings.simulationMode) return undefined
			if (simulationStatePromise === undefined) simulationStatePromise = (async () => {
				const simulationInput = await getSimulationInput()
				if (simulationInput === undefined) return undefined
				return await buildSimulationStateFromPreparedInput(simulationInput, ethereum)
			})()
			return await simulationStatePromise
		}
		const resolved = await handleRPCRequest(ethereum, tokenPriceService, resetSimulationServices, getSimulationInput, getExecutionSimulationState, getSimulationState, websiteTabConnections, request.uniqueRequestIdentifier.requestSocket, website, request, settings, activeAddress)
		return replyToInterceptedRequest(websiteTabConnections, { ...requestWithDefinedParams, ...resolved })
	} catch (error: unknown) {
		if ((error instanceof Error && isFailedToFetchError(error))) {
			return replyToInterceptedRequest(websiteTabConnections, { type: 'result', ...getRequestWithDefinedParams(request), ...METAMASK_ERROR_NOT_CONNECTED_TO_CHAIN })
		}
		if (error instanceof JsonRpcResponseError) {
			return replyToInterceptedRequest(websiteTabConnections, { type: 'result', ...getRequestWithDefinedParams(request), ...error.serialize() })
		}
		handleUnexpectedError(error)
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

async function gateKeepRequestBehindAccessDialog(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, resetSimulationServices: ResetSimulationServices, websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, request: InterceptedRequest, website: Website, currentActiveAddress: bigint | undefined, settings: Settings) {
	const activeAddress = currentActiveAddress !== undefined ? await getActiveAddressEntry(currentActiveAddress) : undefined
	return await requestAccessFromUser(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, socket, website, request, activeAddress, settings, currentActiveAddress)
}

export async function popupMessageHandler(
	websiteTabConnections: WebsiteTabConnections,
	ethereum: EthereumClientService,
	tokenPriceService: TokenPriceService,
	resetSimulationServices: ResetSimulationServices,
	request: unknown,
	settings: Settings
) {
	const maybeParsedRequest = PopupMessage.safeParse(request)
	if (maybeParsedRequest.success === false) {
		// biome-ignore lint/suspicious/noConsoleLog: <Used for support debugging>
		console.log({ request })
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
				case 'popup_modifyMakeMeRich': return await modifyMakeMeRich(ethereum, tokenPriceService, parsedRequest)
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
				case 'popup_interceptorAccess': return await confirmRequestAccess(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, parsedRequest)
				case 'popup_changeInterceptorAccess': return await changeInterceptorAccess(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, parsedRequest)
				case 'popup_changeActiveRpc': return await popupChangeActiveRpc(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, parsedRequest, settings)
				case 'popup_changeChainDialog': return await changeChainDialog(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, parsedRequest)
				case 'popup_enableSimulationMode': return await enableSimulationMode(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, parsedRequest)
				case 'popup_addOrModifyAddressBookEntry': return await addOrModifyAddressBookEntry(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, parsedRequest)
				case 'popup_getAddressBookData': return await getAddressBookData(parsedRequest)
				case 'popup_removeAddressBookEntry': return await removeAddressBookEntry(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, parsedRequest)
				case 'popup_openAddressBook': return await openNewTab('addressBook')
				case 'popup_requestNewHomeData': return await requestNewHomeData(ethereum, tokenPriceService, simulationAbortController)
				case 'popup_refreshHomeData': return await refreshHomeData(ethereum, tokenPriceService)
				case 'popup_requestSettings': return await settingsOpened()
				case 'popup_refreshInterceptorAccessMetadata': return await interceptorAccessMetadataRefresh()
				case 'popup_interceptorAccessChangeAddress': return await interceptorAccessChangeAddressOrRefresh(websiteTabConnections, parsedRequest)
				case 'popup_interceptorAccessRefresh': return await interceptorAccessChangeAddressOrRefresh(websiteTabConnections, parsedRequest)
				case 'popup_ChangeSettings': return await changeSettings(ethereum, tokenPriceService, resetSimulationServices, parsedRequest, simulationAbortController)
				case 'popup_openSettings': return await openNewTab('settingsView')
				case 'popup_import_settings': return await importSettings(parsedRequest)
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
				case 'popup_readyAndListening': return await popupReadyAndListening(ethereum, tokenPriceService, parsedRequest.data.page)
				case 'popup_UnexpectedErrorOccured': return await handleUnexpectedErrorInWindow(parsedRequest)
				case 'popup_requestInterceptorSimulationInput': return await requestInterceptorSimulationInput(ethereum)
				case 'popup_importSimulationStack': return await importSimulationStack(ethereum, tokenPriceService, parsedRequest)
				case 'popup_requestCompleteVisualizedSimulation': {
					await requestCompleteVisualizedSimulation(ethereum, tokenPriceService)
					return
				}
				case 'popup_requestSimulationMetadata': return await requestSimulationMetadata(ethereum)
				case 'popup_requestIdentifyAddress': return await requestIdentifyAddress(ethereum, parsedRequest)
				case 'popup_isMainPopupWindowOpen': return
				default: assertUnreachable(parsedRequest)
			}
		}
		const requestReply = await processRequest()
		if (requestReply === undefined) return undefined
		return PopupReplyOption.serialize(requestReply)
	} catch(error: unknown) {
		if (error instanceof Error && (isNewBlockAbort(error) || isFailedToFetchError(error))) return
		throw error
	}
}
