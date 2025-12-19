import { InpageScriptRequest, PopupMessage, RPCReply, Settings } from '../types/interceptor-messages.js'
import 'webextension-polyfill'
import { Simulator } from '../simulation/simulator.js'
import { getSimulationResults, getTabState, promoteRpcAsPrimary, setLatestUnexpectedError, updateInterceptorTransactionStack, updateSimulationResults } from './storageVariables.js'
import { changeSimulationMode, getKeepSelectedAddressRichEvenIfIChangeAddress, getMakeMeRich, getMakeMeRichList, getSettings, setMakeMeRichList } from './settings.js'
import { blockNumber, call, chainId, estimateGas, gasPrice, getAccounts, getBalance, getBlockByNumber, getCode, getLogs, getPermissions, getTransactionByHash, getTransactionCount, getTransactionReceipt, netVersion, personalSign, sendTransaction, subscribe, switchEthereumChain, unsubscribe, web3ClientVersion, getBlockByHash, feeHistory, installNewFilter, uninstallNewFilter, getFilterChanges, getFilterLogs, handleIterceptorError, requestInterceptorSimulatorStack } from './simulationModeHanders.js'
import { changeActiveAddress, changePage, confirmDialog, refreshSimulation, removeTransactionOrSignedMessage, requestAccountsFromSigner, refreshPopupConfirmTransactionSimulation, confirmRequestAccess, changeInterceptorAccess, changeChainDialog, popupChangeActiveRpc, enableSimulationMode, addOrModifyAddressBookEntry, getAddressBookData, removeAddressBookEntry, refreshHomeData, interceptorAccessChangeAddressOrRefresh, refreshPopupConfirmTransactionMetadata, changeSettings, importSettings, exportSettings, setNewRpcList, simulateGovernanceContractExecutionOnPass, openNewTab, settingsOpened, changeAddOrModifyAddressWindowState, requestAbiAndNameFromBlockExplorer, openWebPage, disableInterceptor, requestNewHomeData, setEnsNameForHash, simulateGnosisSafeTransactionOnPass, retrieveWebsiteAccess, blockOrAllowExternalRequests, removeWebsiteAccess, allowOrPreventAddressAccessForWebsite, removeWebsiteAddressAccess, forceSetGasLimitForTransaction, changePreSimulationBlockTimeManipulation, setTransactionOrMessageBlockTimeManipulator, modifyMakeMeRich, requestMakeMeRichList, requestActiveAddresses, requestSimulationMode, requestLatestUnexpectedError, fetchSimulationStackRequestConfirmation, handleUnexpectedErrorInWindow, requestInterceptorSimulationInput, importSimulationStack, requestCompleteVisualizedSimulation, requestSimulationMetadata } from './popupMessageHandlers.js'
import { CompleteVisualizedSimulation, SimulationState, WebsiteCreatedEthereumUnsignedTransactionOrFailed } from '../types/visualizer-types.js'
import { WebsiteTabConnections } from '../types/user-interface-types.js'
import { askForSignerAccountsFromSignerIfNotAvailable, interceptorAccessMetadataRefresh, requestAccessFromUser, updateInterceptorAccessViewWithPendingRequests } from './windows/interceptorAccess.js'
import { METAMASK_ERROR_FAILED_TO_PARSE_REQUEST, METAMASK_ERROR_NOT_AUTHORIZED, METAMASK_ERROR_NOT_CONNECTED_TO_CHAIN, ERROR_INTERCEPTOR_DISABLED, NEW_BLOCK_ABORT } from '../utils/constants.js'
import { sendActiveAccountChangeToApprovedWebsitePorts, sendMessageToApprovedWebsitePorts, updateWebsiteApprovalAccesses, verifyAccess } from './accessManagement.js'
import { getActiveAddressEntry, identifyAddress } from './metadataUtils.js'
import { getActiveAddress, sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { assertNever, assertUnreachable, modifyObject } from '../utils/typescript.js'
import { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { appendTransactionsToInput, mockSignTransaction } from '../simulation/services/SimulationModeEthereumClientService.js'
import { Semaphore } from '../utils/semaphore.js'
import { JsonRpcResponseError, handleUnexpectedError, isFailedToFetchError, isNewBlockAbort, printError } from '../utils/errors.js'
import { updateConfirmTransactionView } from './windows/confirmTransaction.js'
import { updateChainChangeViewWithPendingRequest } from './windows/changeChain.js'
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
import { TokenPriceService } from '../simulation/services/priceEstimator.js'
import { createSimulationStateWithNonceAndBaseFeeFixing, getCurrentSimulationInput, getMakeMeRichListWithCurrent, visualizeSimulatorState } from './simulationUpdating.js'
import { updateFetchSimulationStackRequestWithPendingRequest } from './windows/fetchSimulationStack.js'
import { PopupReplyOption } from '../types/interceptor-reply-messages.js'

const updateSimulationStateSemaphore = new Semaphore(1)
let simulationAbortController = new AbortController()

export async function updateSimulationState(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, invalidateOldState: boolean, onlyIfNotAlreadyUpdating = false) {
	if (onlyIfNotAlreadyUpdating && updateSimulationStateSemaphore.getPermits() === 0) return undefined
	simulationAbortController.abort(new Error(NEW_BLOCK_ABORT))
	simulationAbortController = new AbortController()
	const thisSimulationsController = simulationAbortController
	try {
		return await updateSimulationStateSemaphore.execute(async () => {
			if (thisSimulationsController.signal.aborted) return undefined
			const simulationResults = await getSimulationResults()
			const simulationId = simulationResults.simulationId + 1
			if (invalidateOldState) {
				await updateSimulationResults(modifyObject(simulationResults, { simulationId, simulationResultState: 'invalid', simulationUpdatingState: 'updating' }))
			} else {
				await updateSimulationResults(modifyObject(simulationResults, { simulationId, simulationUpdatingState: 'updating' }))
			}
			const changedMessagePromise = sendPopupMessageToOpenWindows({ method: 'popup_simulation_state_changed', data: { simulationId } })
			const doneState = { simulationUpdatingState: 'done' as const, simulationResultState: 'done' as const, simulationId, activeAddress: (await getSettings()).activeSimulationAddress }
			const emptyDoneResults: CompleteVisualizedSimulation = {
				...doneState,
				addressBookEntries: [],
				tokenPriceEstimates: [],
				tokenPriceQuoteToken: undefined,
				namedTokenIds: [],
				simulationState: undefined,
				visualizedSimulationState: {
					visualizedBlocks: []
				},
				numberOfAddressesMadeRich: (await getMakeMeRichListWithCurrent()).length
			}
			try {
				const oldSimulationStateInput = await getCurrentSimulationInput()
				const updatedSimulationState = await createSimulationStateWithNonceAndBaseFeeFixing(oldSimulationStateInput, ethereum)

				if (updatedSimulationState !== undefined && ethereum.getChainId() === updatedSimulationState.rpcNetwork.chainId) {
					await updateSimulationResults({ ...await visualizeSimulatorState(updatedSimulationState, ethereum, tokenPriceService, thisSimulationsController), ...doneState, numberOfAddressesMadeRich: emptyDoneResults.numberOfAddressesMadeRich })
				} else {
					await updateSimulationResults(modifyObject(emptyDoneResults, { simulationResultState: 'corrupted' as const }))
				}
				await changedMessagePromise
				await sendPopupMessageToOpenWindows({ method: 'popup_simulation_state_changed', data: { simulationId } })
				return updatedSimulationState
			} catch (error) {
				if (error instanceof Error && isNewBlockAbort(error)) return undefined
				if (error instanceof Error && isFailedToFetchError(error)) {
					// if we fail because of connectivity issue, keep the old block results, but try again later
					await updateSimulationResults(modifyObject(simulationResults, { simulationId, simulationUpdatingState: 'updating' }))
					await sendPopupMessageToOpenWindows({ method: 'popup_simulation_state_changed', data: { simulationId }  })
					return undefined
				}
				handleUnexpectedError(error)
				return undefined
			}
		})
	} catch(error: unknown) {
		if (error instanceof Error && (isNewBlockAbort(error) || isFailedToFetchError(error))) return
		printError(error)
	}
	return undefined
}

let confirmTransactionAbortController = new AbortController()

export async function refreshConfirmTransactionSimulation(
	simulator: Simulator,
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
	sendPopupMessageToOpenWindows({ method: 'popup_confirm_transaction_simulation_started' } as const)
	confirmTransactionAbortController.abort(new Error(NEW_BLOCK_ABORT))
	confirmTransactionAbortController = new AbortController()
	const thisConfirmTransactionAbortController = confirmTransactionAbortController
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
			const updatedSimulationState = await createSimulationStateWithNonceAndBaseFeeFixing(simulationStateWithNewTransaction, simulator.ethereum)
			return await visualizeSimulatorState(updatedSimulationState, simulator.ethereum, simulator.tokenPriceService, thisConfirmTransactionAbortController)
		}
		const visualizedSimulatorState = await getNewVisualizedSimulationState()
		const availableAbis = visualizedSimulatorState.addressBookEntries.map((entry) => 'abi' in entry && entry.abi !== undefined ? new Interface(entry.abi) : undefined).filter((abiOrUndefined): abiOrUndefined is Interface => abiOrUndefined !== undefined)
		const blocks = visualizedSimulatorState.visualizedSimulationState.visualizedBlocks
		const lastTransaction = blocks.at(-1)?.simulatedAndVisualizedTransactions.at(-1)
		return {
			statusCode: 'success' as const,
			data: {
				...info,
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
			const identified = await identifyAddress(simulator.ethereum, undefined, params.to)
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
			error: { ...baseError, decodedErrorMessage: decodeEthereumError(await extractToAbi(), baseError).reason },
			simulationState: {
				blockNumber: 0n,
				simulationConductedTimestamp: new Date()
			}
		} }
	}
}

async function handleRPCRequest(
	simulator: Simulator,
	simulationState: SimulationState | undefined,
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
	makeSureInterceptorIsNotSleeping(simulator.ethereum)
	switch (parsedRequest.method) {
		case 'eth_getBlockByHash': return await getBlockByHash(simulator.ethereum, simulationState, parsedRequest)
		case 'eth_getBlockByNumber': return await getBlockByNumber(simulator.ethereum, simulationState, parsedRequest)
		case 'eth_getBalance': return await getBalance(simulator.ethereum, simulationState, parsedRequest)
		case 'eth_estimateGas': return await estimateGas(simulator.ethereum, simulationState, parsedRequest)
		case 'eth_getTransactionByHash': return await getTransactionByHash(simulator.ethereum, simulationState, parsedRequest)
		case 'eth_getTransactionReceipt': return await getTransactionReceipt(simulator.ethereum, simulationState, parsedRequest)
		case 'eth_call': return await call(simulator.ethereum, simulationState, parsedRequest)
		case 'eth_blockNumber': return await blockNumber(simulator.ethereum, simulationState)
		case 'eth_subscribe': return await subscribe(socket, parsedRequest)
		case 'eth_unsubscribe': return await unsubscribe(socket, parsedRequest)
		case 'eth_chainId': return await chainId(simulator.ethereum)
		case 'net_version': return await netVersion(simulator.ethereum)
		case 'eth_getCode': return await getCode(simulator.ethereum, simulationState, parsedRequest)
		case 'personal_sign':
		case 'eth_signTypedData':
		case 'eth_signTypedData_v1':
		case 'eth_signTypedData_v2':
		case 'eth_signTypedData_v3':
		case 'eth_signTypedData_v4': return await personalSign(simulator, activeAddress, simulator.ethereum, parsedRequest, request, website, websiteTabConnections, !forwardToSigner)
		case 'wallet_switchEthereumChain': return await switchEthereumChain(simulator, websiteTabConnections, simulator.ethereum, parsedRequest, request, settings.simulationMode, website)
		case 'wallet_requestPermissions': return await getAccounts(activeAddress)
		case 'wallet_getPermissions': return await getPermissions()
		case 'eth_accounts': return await getAccounts(activeAddress)
		case 'eth_requestAccounts': return await getAccounts(activeAddress)
		case 'eth_gasPrice': return await gasPrice(simulator.ethereum)
		case 'eth_getTransactionCount': return await getTransactionCount(simulator.ethereum, simulationState, parsedRequest)
		case 'interceptor_getSimulationStack': return await requestInterceptorSimulatorStack(simulationState, websiteTabConnections, parsedRequest, website, request, socket)
		case 'eth_simulateV1': return { type: 'result', method: parsedRequest.method, error: { code: 10000, message: 'Cannot call eth_simulateV1 directly' } }
		case 'wallet_addEthereumChain': {
			if (forwardToSigner) return getForwardingMessage(parsedRequest)
			return { type: 'result' as const, method: parsedRequest.method, error: { code: 10000, message: 'wallet_addEthereumChain not implemented' } }
		}
		case 'eth_getStorageAt': {
			if (forwardToSigner) return getForwardingMessage(parsedRequest)
			return { type: 'result' as const, method: parsedRequest.method, error: { code: 10000, message: 'eth_getStorageAt not implemented' } }
		}
		case 'eth_getLogs': return await getLogs(simulator.ethereum, simulationState, parsedRequest)
		case 'eth_sign': return { type: 'result' as const,method: parsedRequest.method, error: { code: 10000, message: 'eth_sign is deprecated' } }
		case 'eth_sendRawTransaction':
		case 'eth_sendTransaction': {
			if (forwardToSigner && settings.activeRpcNetwork.httpsRpc === undefined) return getForwardingMessage(parsedRequest)
			return await sendTransaction(simulator, activeAddress, parsedRequest, request, website, websiteTabConnections, !forwardToSigner)
		}
		case 'web3_clientVersion': return await web3ClientVersion(simulator.ethereum)
		case 'eth_feeHistory': return await feeHistory(simulator.ethereum, parsedRequest)
		case 'eth_newFilter': return await installNewFilter(socket, parsedRequest, simulator.ethereum, simulationState)
		case 'eth_uninstallFilter': return await uninstallNewFilter(socket, parsedRequest)
		case 'eth_getFilterChanges': return await getFilterChanges(parsedRequest, simulator.ethereum, simulationState)
		case 'eth_getFilterLogs': return await getFilterLogs(parsedRequest, simulator.ethereum, simulationState)
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

export async function resetSimulatorStateFromConfig(ethereumClientService: EthereumClientService, tokenPriceService: TokenPriceService) {
	await updateInterceptorTransactionStack(() => ({ operations: [] }))
	await updateSimulationState(ethereumClientService, tokenPriceService, true)
}

const updateRichListAfterActiveAddressChange = async (newActiveAddress: bigint) => {
	if (!await getMakeMeRich()) return
	if (!await getKeepSelectedAddressRichEvenIfIChangeAddress()) return
	const activeAddress = (await getSettings()).activeSimulationAddress
	if (activeAddress === undefined || activeAddress === newActiveAddress) return
	const richList = await getMakeMeRichList()
	await setMakeMeRichList([...richList, activeAddress])
}

const changeActiveAddressAndChainSemaphore = new Semaphore(1)
export async function changeActiveAddressAndChain(
	simulator: Simulator,
	websiteTabConnections: WebsiteTabConnections,
	change: {
		simulationMode: boolean,
		activeAddress?: bigint,
		rpcNetwork?: RpcNetwork,
	},
) {

	if (change.simulationMode && change.activeAddress !== undefined) await updateRichListAfterActiveAddressChange(change.activeAddress)

	if (change.simulationMode) {
		await changeSimulationMode({ ...change, ...'activeAddress' in change ? { activeSimulationAddress: change.activeAddress } : {} })
	} else {
		await changeSimulationMode({ ...change, ...'activeAddress' in change ? { activeSigningAddress: change.activeAddress } : {} })
	}

	const updatedSettings = await getSettings()
	sendPopupMessageToOpenWindows({ method: 'popup_settingsUpdated', data: updatedSettings })
	updateWebsiteApprovalAccesses(simulator, websiteTabConnections, updatedSettings)
	sendPopupMessageToOpenWindows({ method: 'popup_accounts_update' })
	await changeActiveAddressAndChainSemaphore.execute(async () => {
		if (change.rpcNetwork !== undefined) {
			if (change.rpcNetwork.httpsRpc !== undefined) simulator.reset(change.rpcNetwork)
			sendMessageToApprovedWebsitePorts(websiteTabConnections, { method: 'chainChanged' as const, result: change.rpcNetwork.chainId })
			sendPopupMessageToOpenWindows({ method: 'popup_chain_update' })

			// reset simulation if chain id was changed
			if (updatedSettings.simulationMode) await resetSimulatorStateFromConfig(simulator.ethereum, simulator.tokenPriceService)
		}
		// inform website about this only after we have updated simulation, as they often query the balance right after
		sendActiveAccountChangeToApprovedWebsitePorts(websiteTabConnections, await getSettings())
	})
}

export async function changeActiveRpc(simulator: Simulator, websiteTabConnections: WebsiteTabConnections, rpcNetwork: RpcNetwork, simulationMode: boolean) {
	// allow switching RPC only if we are in simulation mode, or that chain id would not change
	if (simulationMode || rpcNetwork.chainId === (await getSettings()).activeRpcNetwork.chainId) return await changeActiveAddressAndChain(simulator, websiteTabConnections, { simulationMode, rpcNetwork })
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

export const handleInterceptedRequest = async (port: browser.runtime.Port | undefined, websiteOrigin: string, websitePromise: Promise<Website> | Website, simulator: Simulator, socket: WebsiteSocket, request: InterceptedRequest, websiteTabConnections: WebsiteTabConnections): Promise<unknown> => {
	const activeAddress = await getActiveAddress(await getSettings(), socket.tabId)
	const access = verifyAccess(websiteTabConnections, socket, request.method === 'eth_requestAccounts' || request.method === 'eth_call', websiteOrigin, activeAddress, await getSettings())
	if (access === 'interceptorDisabled') return replyToInterceptedRequest(websiteTabConnections, { type: 'result', ...request, ...ERROR_INTERCEPTOR_DISABLED })
	const providerHandler = getProviderHandler(request.method)
	const identifiedMethod = providerHandler.method
	if (identifiedMethod !== 'notProviderMethod') {
		if (port === undefined) return
		const providerHandlerReturn = await providerHandler.func(simulator, websiteTabConnections, port, request, access, activeAddress?.address)
		if (providerHandlerReturn.type === 'doNotReply') return
		const message: InpageScriptRequest = { uniqueRequestIdentifier: request.uniqueRequestIdentifier, ...providerHandlerReturn }
		return replyToInterceptedRequest(websiteTabConnections, message)
	}
	if (access === 'hasAccess' && activeAddress === undefined && request.method === 'eth_requestAccounts') {
		// user has granted access to the site, but not to this account and the application is requesting accounts
		const account = await askForSignerAccountsFromSignerIfNotAvailable(websiteTabConnections, socket)
		if (account.length === 0) return refuseAccess(websiteTabConnections, request)
		const result: unknown = await handleInterceptedRequest(port, websiteOrigin, websitePromise, simulator, socket, request, websiteTabConnections)
		return result
	}

	if (access === 'noAccess' || activeAddress === undefined) {
		switch (request.method) {
			case 'eth_accounts': return replyToInterceptedRequest(websiteTabConnections, { type: 'result', method: 'eth_accounts' as const, result: [], uniqueRequestIdentifier: request.uniqueRequestIdentifier })
			// if user has not given access, assume we are on chain 1
			case 'eth_chainId': return replyToInterceptedRequest(websiteTabConnections, { type: 'result', method: request.method, result: 1n, uniqueRequestIdentifier: request.uniqueRequestIdentifier })
			case 'net_version': return replyToInterceptedRequest(websiteTabConnections, { type: 'result', method: request.method, result: 1n, uniqueRequestIdentifier: request.uniqueRequestIdentifier })
			default: break
		}
	}

	switch (access) {
		case 'askAccess': return await gateKeepRequestBehindAccessDialog(simulator, websiteTabConnections, socket, request, await websitePromise, activeAddress?.address, await getSettings())
		case 'noAccess': return refuseAccess(websiteTabConnections, request)
		case 'hasAccess': {
			if (activeAddress === undefined) return refuseAccess(websiteTabConnections, request)
			return await handleContentScriptMessage(simulator, websiteTabConnections, request, await websitePromise, activeAddress?.address)
		}
		default: assertNever(access)
	}
}

async function handleContentScriptMessage(simulator: Simulator, websiteTabConnections: WebsiteTabConnections, request: InterceptedRequest, website: Website, activeAddress: bigint | undefined) {
	try {
		const settings = await getSettings()
		const simulationState = settings.simulationMode ? (await getSimulationResults()).simulationState : undefined
		const resolved = await handleRPCRequest(simulator, simulationState, websiteTabConnections, request.uniqueRequestIdentifier.requestSocket, website, request, settings, activeAddress)
		return replyToInterceptedRequest(websiteTabConnections, { ...request, ...resolved })
	} catch (error) {
		if (error instanceof Error && isFailedToFetchError(error)) {
			return replyToInterceptedRequest(websiteTabConnections, { type: 'result', ...request, ...METAMASK_ERROR_NOT_CONNECTED_TO_CHAIN })
		}
		handleUnexpectedError(error)
		return replyToInterceptedRequest(websiteTabConnections, {
			type: 'result',
			...request,
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

async function gateKeepRequestBehindAccessDialog(simulator: Simulator, websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, request: InterceptedRequest, website: Website, currentActiveAddress: bigint | undefined, settings: Settings) {
	const activeAddress = currentActiveAddress !== undefined ? await getActiveAddressEntry(currentActiveAddress) : undefined
	return await requestAccessFromUser(simulator, websiteTabConnections, socket, website, request, activeAddress, settings, currentActiveAddress)
}

export async function popupMessageHandler(
	websiteTabConnections: WebsiteTabConnections,
	simulator: Simulator,
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
				case 'popup_confirmDialog': return await confirmDialog(simulator, websiteTabConnections, parsedRequest)
				case 'popup_changeActiveAddress': return await changeActiveAddress(simulator, websiteTabConnections, parsedRequest)
				case 'popup_modifyMakeMeRich': return await modifyMakeMeRich(simulator, parsedRequest)
				case 'popup_changePage': return await changePage(parsedRequest)
				case 'popup_requestAccountsFromSigner': return await requestAccountsFromSigner(websiteTabConnections, parsedRequest)
				case 'popup_resetSimulation': return await resetSimulatorStateFromConfig(simulator.ethereum, simulator.tokenPriceService)
				case 'popup_removeTransactionOrSignedMessage': return await removeTransactionOrSignedMessage(simulator, parsedRequest)
				case 'popup_refreshSimulation': {
					await refreshSimulation(simulator, false)
					return
				}
				case 'popup_refreshConfirmTransactionDialogSimulation': return await refreshPopupConfirmTransactionSimulation(simulator)
				case 'popup_refreshConfirmTransactionMetadata': return refreshPopupConfirmTransactionMetadata(simulator.ethereum, confirmTransactionAbortController, simulator.tokenPriceService)
				case 'popup_interceptorAccess': return await confirmRequestAccess(simulator, websiteTabConnections, parsedRequest)
				case 'popup_changeInterceptorAccess': return await changeInterceptorAccess(simulator, websiteTabConnections, parsedRequest)
				case 'popup_changeActiveRpc': return await popupChangeActiveRpc(simulator, websiteTabConnections, parsedRequest, settings)
				case 'popup_changeChainDialog': return await changeChainDialog(simulator, websiteTabConnections, parsedRequest)
				case 'popup_enableSimulationMode': return await enableSimulationMode(simulator, websiteTabConnections, parsedRequest)
				case 'popup_addOrModifyAddressBookEntry': return await addOrModifyAddressBookEntry(simulator, websiteTabConnections, parsedRequest)
				case 'popup_getAddressBookData': return await getAddressBookData(parsedRequest)
				case 'popup_removeAddressBookEntry': return await removeAddressBookEntry(simulator, websiteTabConnections, parsedRequest)
				case 'popup_openAddressBook': return await openNewTab('addressBook')
				case 'popup_changeChainReadyAndListening': return await updateChainChangeViewWithPendingRequest()
				case 'popup_interceptorAccessReadyAndListening': return await updateInterceptorAccessViewWithPendingRequests()
				case 'popup_confirmTransactionReadyAndListening': {
					await updateConfirmTransactionView(simulator.ethereum)
					return
				}
				case 'popup_requestNewHomeData': return await requestNewHomeData(simulator, simulationAbortController)
				case 'popup_refreshHomeData': return await refreshHomeData(simulator)
				case 'popup_requestSettings': return await settingsOpened()
				case 'popup_refreshInterceptorAccessMetadata': return await interceptorAccessMetadataRefresh()
				case 'popup_interceptorAccessChangeAddress': return await interceptorAccessChangeAddressOrRefresh(websiteTabConnections, parsedRequest)
				case 'popup_interceptorAccessRefresh': return await interceptorAccessChangeAddressOrRefresh(websiteTabConnections, parsedRequest)
				case 'popup_ChangeSettings': return await changeSettings(simulator, parsedRequest, simulationAbortController)
				case 'popup_openSettings': return await openNewTab('settingsView')
				case 'popup_import_settings': return await importSettings(parsedRequest)
				case 'popup_get_export_settings': return await exportSettings()
				case 'popup_set_rpc_list': return await setNewRpcList(simulator, parsedRequest, settings)
				case 'popup_simulateGovernanceContractExecution': return await simulateGovernanceContractExecutionOnPass(simulator.ethereum, simulator.tokenPriceService, parsedRequest)
				case 'popup_simulateGnosisSafeTransaction': return await simulateGnosisSafeTransactionOnPass(simulator.ethereum, simulator.tokenPriceService, parsedRequest.data.gnosisSafeMessage)
				case 'popup_changeAddOrModifyAddressWindowState': return await changeAddOrModifyAddressWindowState(simulator.ethereum, parsedRequest)
				case 'popup_requestAbiAndNameFromBlockExplorer': return await requestAbiAndNameFromBlockExplorer(parsedRequest)
				case 'popup_openWebPage': return await openWebPage(parsedRequest)
				case 'popup_setDisableInterceptor': return await disableInterceptor(simulator, websiteTabConnections, parsedRequest)
				case 'popup_clearUnexpectedError': return await setLatestUnexpectedError(undefined)
				case 'popup_setEnsNameForHash': return await setEnsNameForHash(parsedRequest)
				case 'popup_openWebsiteAccess': return await openNewTab('websiteAccess')
				case 'popup_retrieveWebsiteAccess': return await retrieveWebsiteAccess(parsedRequest)
				case 'popup_blockOrAllowExternalRequests': return await blockOrAllowExternalRequests(simulator, websiteTabConnections, parsedRequest)
				case 'popup_allowOrPreventAddressAccessForWebsite': return await allowOrPreventAddressAccessForWebsite(websiteTabConnections, parsedRequest)
				case 'popup_removeWebsiteAccess': return await removeWebsiteAccess(simulator, websiteTabConnections, parsedRequest)
				case 'popup_removeWebsiteAddressAccess': return await removeWebsiteAddressAccess(simulator, websiteTabConnections, parsedRequest)
				case 'popup_forceSetGasLimitForTransaction': return await forceSetGasLimitForTransaction(simulator, parsedRequest)
				case 'popup_changePreSimulationBlockTimeManipulation': return await changePreSimulationBlockTimeManipulation(simulator, parsedRequest)
				case 'popup_setTransactionOrMessageBlockTimeManipulator': return await setTransactionOrMessageBlockTimeManipulator(simulator, parsedRequest)
				case 'popup_requestMakeMeRichData': return await requestMakeMeRichList(simulator.ethereum, simulationAbortController)
				case 'popup_requestActiveAddresses': return await requestActiveAddresses()
				case 'popup_requestSimulationMode': return await requestSimulationMode()
				case 'popup_requestLatestUnexpectedError': return await requestLatestUnexpectedError()
				case 'popup_fetchSimulationStackRequestConfirmation': return await fetchSimulationStackRequestConfirmation(websiteTabConnections, parsedRequest)
				case 'popup_fetchSimulationStackRequestReadyAndListening': return await updateFetchSimulationStackRequestWithPendingRequest()
				case 'popup_UnexpectedErrorOccured': return await handleUnexpectedErrorInWindow(parsedRequest)
				case 'popup_requestInterceptorSimulationInput': return await requestInterceptorSimulationInput(simulator.ethereum)
				case 'popup_importSimulationStack': return await importSimulationStack(simulator, parsedRequest)
				case 'popup_requestCompleteVisualizedSimulation': return await requestCompleteVisualizedSimulation()
				case 'popup_requestSimulationMetadata': return await requestSimulationMetadata(simulator.ethereum)
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
