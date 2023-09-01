import { PopupMessage, RPCReply, Settings } from '../types/interceptor-messages.js'
import 'webextension-polyfill'
import { Simulator } from '../simulation/simulator.js'
import { getEthDonator, getSignerName, getSimulationResults, updateSimulationResults } from './storageVariables.js'
import { changeSimulationMode, getSettings, getMakeMeRich } from './settings.js'
import { blockNumber, call, chainId, estimateGas, gasPrice, getAccounts, getBalance, getBlockByNumber, getCode, getLogs, getPermissions, getSimulationStack, getTransactionByHash, getTransactionCount, getTransactionReceipt, netVersion, personalSign, sendTransaction, subscribe, switchEthereumChain, unsubscribe } from './simulationModeHanders.js'
import { changeActiveAddress, changeMakeMeRich, changePage, resetSimulation, confirmDialog, refreshSimulation, removeTransaction, requestAccountsFromSigner, refreshPopupConfirmTransactionSimulation, confirmPersonalSign, confirmRequestAccess, changeInterceptorAccess, changeChainDialog, popupChangeActiveRpc, enableSimulationMode, addOrModifyAddressInfo, getAddressBookData, removeAddressBookEntry, openAddressBook, homeOpened, interceptorAccessChangeAddressOrRefresh, refreshPopupConfirmTransactionMetadata, changeSettings, importSettings, exportSettings, setNewRpcList, popupIdentifyAddress, popupFindAddressBookEntryWithSymbolOrName } from './popupMessageHandlers.js'
import { SimulationState, RpcNetwork, WebsiteCreatedEthereumUnsignedTransaction } from '../types/visualizer-types.js'
import { ConfirmTransactionTransactionSingleVisualization, WebsiteTabConnections } from '../types/user-interface-types.js'
import { interceptorAccessMetadataRefresh, requestAccessFromUser, updateInterceptorAccessViewWithPendingRequests } from './windows/interceptorAccess.js'
import { MAKE_YOU_RICH_TRANSACTION, METAMASK_ERROR_FAILED_TO_PARSE_REQUEST, METAMASK_ERROR_NOT_AUTHORIZED, METAMASK_ERROR_NOT_CONNECTED_TO_CHAIN } from '../utils/constants.js'
import { PriceEstimator } from '../simulation/priceEstimator.js'
import { sendActiveAccountChangeToApprovedWebsitePorts, sendMessageToApprovedWebsitePorts, updateWebsiteApprovalAccesses } from './accessManagement.js'
import { findAddressInfo, getAddressBookEntriesForVisualiser } from './metadataUtils.js'
import { sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { assertUnreachable } from '../utils/typescript.js'
import { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { appendTransaction, copySimulationState, getNonPrependedSimulatedTransactions, getNonceFixedSimulatedTransactions, getWebsiteCreatedEthereumUnsignedTransactions, setPrependTransactionsQueue, setSimulationTransactions } from '../simulation/services/SimulationModeEthereumClientService.js'
import { Semaphore } from '../utils/semaphore.js'
import { FetchResponseError, JsonRpcResponseError, isFailedToFetchError } from '../utils/errors.js'
import { formSimulatedAndVisualizedTransaction } from '../components/formVisualizerResults.js'
import { updateConfirmTransactionViewWithPendingTransaction } from './windows/confirmTransaction.js'
import { updateChainChangeViewWithPendingRequest } from './windows/changeChain.js'
import { updatePendingPersonalSignViewWithPendingRequests } from './windows/personalSign.js'
import { InterceptedRequest, UniqueRequestIdentifier, WebsiteSocket } from '../utils/requests.js'
import { replyToInterceptedRequest } from './messageSending.js'
import { EthGetStorageAtParams, EthereumJsonRpcRequest, SendRawTransactionParams, SendTransactionParams, SupportedEthereumJsonRpcRequestMethods, WalletAddEthereumChain } from '../types/JsonRpc-types.js'
import { AddressBookEntry } from '../types/addressBookTypes.js'
import { Website } from '../types/websiteAccessTypes.js'

async function visualizeSimulatorState(simulationState: SimulationState, simulator: Simulator) {
	const priceEstimator = new PriceEstimator(simulator.ethereum)
	const transactions = getWebsiteCreatedEthereumUnsignedTransactions(simulationState.simulatedTransactions)
	const visualizerResult = await simulator.visualizeTransactionChain(simulationState, transactions, simulationState.blockNumber, simulationState.simulatedTransactions.map((x) => x.multicallResponse))
	const visualizerResults = visualizerResult.map((x, i) => ({ ...x, website: simulationState.simulatedTransactions[i].website }))
	const addressBookEntries = await getAddressBookEntriesForVisualiser(simulator.ethereum, visualizerResult.map((x) => x.visualizerResults), simulationState, (await getSettings()).userAddressBook)
	const simulatedAndVisualizedTransactions = formSimulatedAndVisualizedTransaction(simulationState, visualizerResults, addressBookEntries)

	function onlyTokensAndTokensWithKnownDecimals(metadata: AddressBookEntry): metadata is AddressBookEntry & { type: 'ERC20', decimals: `0x${string}` } {
		if (metadata.type !== 'ERC20') return false
		if (metadata.decimals === undefined) return false
		return true
	}
	function metadataRestructure(metadata: AddressBookEntry & { type: 'ERC20', decimals: bigint }) {
		return { address: metadata.address, decimals: metadata.decimals }
	}
	const tokenPrices = await priceEstimator.estimateEthereumPricesForTokens(addressBookEntries.filter(onlyTokensAndTokensWithKnownDecimals).map(metadataRestructure))
	return {
		tokenPrices,
		addressBookEntries,
		visualizerResults,
		simulationState,
		simulatedAndVisualizedTransactions,
	}
}

const updateSimulationStateSemaphore = new Semaphore(1)
export async function updateSimulationState(simulator: Simulator, getUpdatedSimulationState: (simulationState: SimulationState | undefined) => Promise<SimulationState | undefined>, activeAddress: bigint | undefined, invalidateOldState: boolean) {
	return await updateSimulationStateSemaphore.execute(async () => {
		const simulationResults = await getSimulationResults()
		const simulationId = simulationResults.simulationId + 1
		if (invalidateOldState) {
			await updateSimulationResults({ ...simulationResults, simulationId, simulationResultState: 'invalid', simulationUpdatingState: 'updating' })
		} else {
			await updateSimulationResults({ ...simulationResults, simulationId, simulationUpdatingState: 'updating' })
		}
		await sendPopupMessageToOpenWindows({ method: 'popup_simulation_state_changed', data: { simulationId } })
		try {
			const updatedSimulationState = await getUpdatedSimulationState(simulationResults.simulationState)
			if (updatedSimulationState !== undefined) {
				await updateSimulationResults({
					...await visualizeSimulatorState(updatedSimulationState, simulator),
					simulationUpdatingState: 'done',		
					simulationResultState: 'done',
					simulationId,
					activeAddress: activeAddress,
				})
			} else {
				await updateSimulationResults({
					simulationUpdatingState: 'done',
					simulationResultState: 'done',
					simulationId,
					addressBookEntries: [],
					tokenPrices: [],
					visualizerResults: [],
					simulationState: updatedSimulationState,
					activeAddress: activeAddress,
				})
			}
			await sendPopupMessageToOpenWindows({ method: 'popup_simulation_state_changed', data: { simulationId } })
			return updatedSimulationState
		} catch (error) {
			if (error instanceof Error) {
				if (isFailedToFetchError(error)) {
					await updateSimulationResults({ ...simulationResults, simulationId, simulationUpdatingState: 'updating' })
					await sendPopupMessageToOpenWindows({ method: 'popup_simulation_state_changed', data: { simulationId }  })
					return undefined
				}
			}
			throw error
		}
	})
}

export async function refreshConfirmTransactionSimulation(
	simulator: Simulator,
	ethereumClientService: EthereumClientService,
	activeAddress: bigint,
	simulationMode: boolean,
	uniqueRequestIdentifier: UniqueRequestIdentifier,
	transactionToSimulate: WebsiteCreatedEthereumUnsignedTransaction,
): Promise<ConfirmTransactionTransactionSingleVisualization> {
	const info = {
		uniqueRequestIdentifier,
		transactionToSimulate: transactionToSimulate,
		simulationMode: simulationMode,
		activeAddress: activeAddress,
		signerName: await getSignerName(),
		tabIdOpenedFrom: uniqueRequestIdentifier.requestSocket.tabId,
	}
	sendPopupMessageToOpenWindows({ method: 'popup_confirm_transaction_simulation_started' } as const)

	const getCopiedSimulationState = async (simulationMode: boolean) => {
		if (simulationMode === false) return undefined
		const simResults = await getSimulationResults()
		if (simResults.simulationState === undefined) return undefined
		return copySimulationState(simResults.simulationState)
	}

	try {
		const simulationStateWithNewTransaction = await appendTransaction(ethereumClientService, await getCopiedSimulationState(simulationMode), transactionToSimulate)
		const noncefixed = await getNonceFixedSimulatedTransactions(ethereumClientService, simulationStateWithNewTransaction.simulatedTransactions)
		if (noncefixed === 'NoNonceErrors') {
			return {
				statusCode: 'success' as const,
				data: { ...info, ...await visualizeSimulatorState(simulationStateWithNewTransaction, simulator) }
			}
		}
		const noncefixedNotPrepended = getWebsiteCreatedEthereumUnsignedTransactions(getNonPrependedSimulatedTransactions(simulationStateWithNewTransaction.prependTransactionsQueue, noncefixed))
		const nonceFixedState = await setSimulationTransactions(ethereumClientService, simulationStateWithNewTransaction, noncefixedNotPrepended)
		return {
			statusCode: 'success' as const,
			data: {
				...info,
				...await visualizeSimulatorState(nonceFixedState, simulator),
				transactionToSimulate: {
					...transactionToSimulate,
					transaction: {
						...transactionToSimulate.transaction,
						nonce: noncefixed[noncefixed.length - 1].signedTransaction.nonce,
					}
				}
			}
		}
	} catch (error) {
		if (!(error instanceof Error)) throw error
		if (!isFailedToFetchError(error)) throw error
		return { statusCode: 'failed' as const, data: info }
	}
}

// returns true if simulation state was changed
export async function getPrependTrasactions(ethereumClientService: EthereumClientService, settings: Settings, richMode: boolean): Promise<WebsiteCreatedEthereumUnsignedTransaction[]> {
	if (!settings.simulationMode || !richMode) return []
	const activeAddress = settings.activeSimulationAddress
	const chainId = settings.rpcNetwork.chainId
	const donatorAddress = getEthDonator(chainId)
	if (donatorAddress === undefined) return []
	if (activeAddress === undefined) return []
	return [{
		transaction: {
			from: donatorAddress,
			chainId: chainId,
			nonce: await ethereumClientService.getTransactionCount(donatorAddress),
			to: activeAddress,
			...MAKE_YOU_RICH_TRANSACTION.transaction,
		},
		website: MAKE_YOU_RICH_TRANSACTION.website,
		transactionCreated: new Date(),
		originalTransactionRequestParameters: { method: MAKE_YOU_RICH_TRANSACTION.transactionSendingFormat, params: [{}] },
		error: undefined,
	}]
}

async function handleRPCRequest(
	simulator: Simulator,
	simulationState: SimulationState | undefined,
	websiteTabConnections: WebsiteTabConnections,
	ethereumClientService: EthereumClientService,
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
		return { forward: true as const, ...request }
	}

	if (maybeParsedRequest.success === false) {
		console.log(request)
		console.warn(maybeParsedRequest.fullError)
		const maybePartiallyParsedRequest = SupportedEthereumJsonRpcRequestMethods.safeParse(request)
		// the method is some method that we are not supporting, forward it to the wallet if signer is available
		if (maybePartiallyParsedRequest.success === false && forwardToSigner) return { forward: true as const, unknownMethod: true, ...request }
		return {
			method: request.method,
			error: {
				message: `Failed to parse RPC request: ${ InterceptedRequest.serialize(request) }`,
				data: maybeParsedRequest.fullError === undefined ? 'Failed to parse RPC request' : maybeParsedRequest.fullError.toString(),
				code: METAMASK_ERROR_FAILED_TO_PARSE_REQUEST,
			}
		}
	}
	const parsedRequest = maybeParsedRequest.value

	switch (parsedRequest.method) {
		case 'eth_getBlockByNumber': return await getBlockByNumber(ethereumClientService, simulationState, parsedRequest)
		case 'eth_getBalance': return await getBalance(ethereumClientService, simulationState, parsedRequest)
		case 'eth_estimateGas': return await estimateGas(ethereumClientService, simulationState, parsedRequest)
		case 'eth_getTransactionByHash': return await getTransactionByHash(ethereumClientService, simulationState, parsedRequest)
		case 'eth_getTransactionReceipt': return await getTransactionReceipt(ethereumClientService, simulationState, parsedRequest)
		case 'eth_call': return await call(ethereumClientService, simulationState, parsedRequest)
		case 'eth_blockNumber': return await blockNumber(ethereumClientService, simulationState)
		case 'eth_subscribe': return await subscribe(socket, parsedRequest)
		case 'eth_unsubscribe': return await unsubscribe(socket, parsedRequest)
		case 'eth_chainId': return await chainId(ethereumClientService)
		case 'net_version': return await netVersion(ethereumClientService)
		case 'eth_getCode': return await getCode(ethereumClientService, simulationState, parsedRequest)
		case 'personal_sign':
		case 'eth_signTypedData':
		case 'eth_signTypedData_v1':
		case 'eth_signTypedData_v2':
		case 'eth_signTypedData_v3':
		case 'eth_signTypedData_v4': return await personalSign(ethereumClientService, websiteTabConnections, parsedRequest, request, settings.simulationMode, website, activeAddress)
		case 'wallet_switchEthereumChain': return await switchEthereumChain(simulator, websiteTabConnections, ethereumClientService, parsedRequest, request, settings.simulationMode, website)
		case 'wallet_requestPermissions': return await getAccounts(activeAddress)
		case 'wallet_getPermissions': return await getPermissions()
		case 'eth_accounts': return await getAccounts(activeAddress)
		case 'eth_requestAccounts': return await getAccounts(activeAddress)
		case 'eth_gasPrice': return await gasPrice(ethereumClientService)
		case 'eth_getTransactionCount': return await getTransactionCount(ethereumClientService, simulationState, parsedRequest)
		case 'interceptor_getSimulationStack': return await getSimulationStack(simulationState, parsedRequest)
		case 'eth_multicall': return { method: parsedRequest.method, error: { code: 10000, message: 'Cannot call eth_multicall directly' } }
		case 'eth_multicallV1': return { method: parsedRequest.method, error: { code: 10000, message: 'Cannot call eth_multicallV1 directly' } }
		case 'wallet_addEthereumChain': {
			if (forwardToSigner) return getForwardingMessage(parsedRequest)
			return { method: parsedRequest.method, error: { code: 10000, message: 'wallet_addEthereumChain not implemented' } }
		}
		case 'eth_getStorageAt': {
			if (forwardToSigner) return getForwardingMessage(parsedRequest)
			return { method: parsedRequest.method, error: { code: 10000, message: 'eth_getStorageAt not implemented' } }
		}
		case 'eth_getLogs': return await getLogs(ethereumClientService, simulationState, parsedRequest)
		case 'eth_sign': return { method: parsedRequest.method, error: { code: 10000, message: 'eth_sign is deprecated' } }
		case 'eth_sendRawTransaction':
		case 'eth_sendTransaction': {
			if (forwardToSigner && settings.rpcNetwork.httpsRpc === undefined) return getForwardingMessage(parsedRequest)
			const message = await sendTransaction(simulator, activeAddress, ethereumClientService, parsedRequest, request, !forwardToSigner, website)
			if ('forward' in message) return getForwardingMessage(parsedRequest)
			return message
		}
		/*
		Missing methods:
		case 'eth_getProof': return
		case 'eth_getBlockTransactionCountByNumber': return
		case 'eth_getTransactionByBlockHashAndIndex': return
		case 'eth_getTransactionByBlockNumberAndIndex': return
		case 'eth_getBlockReceipts': return

		case 'eth_getFilterChanges': return
		case 'eth_getFilterLogs': return
		case 'eth_newBlockFilter': return
		case 'eth_newFilter': return
		case 'eth_newPendingTransactionFilter': return
		case 'eth_uninstallFilter': return

		case 'eth_protocolVersion': return
		case 'eth_feeHistory': return
		case 'eth_maxPriorityFeePerGas': return
		case 'net_listening': return

		case 'eth_getUncleByBlockHashAndIndex': return
		case 'eth_getUncleByBlockNumberAndIndex': return
		case 'eth_getUncleCountByBlockHash': return
		case 'eth_getUncleCountByBlockNumber': return
		*/
	}
}

const changeActiveAddressAndChainAndResetSimulationSemaphore = new Semaphore(1)
export async function changeActiveAddressAndChainAndResetSimulation(
	simulator: Simulator,
	websiteTabConnections: WebsiteTabConnections,
	change: {
		simulationMode: boolean,
		activeAddress?: bigint,
		rpcNetwork?: RpcNetwork,
	},
) {
	await changeActiveAddressAndChainAndResetSimulationSemaphore.execute(async () => {
		if (change.simulationMode) {
			await changeSimulationMode({
				...change,
				...'activeAddress' in change ? { activeSimulationAddress: change.activeAddress } : {}
			})
		} else {
			await changeSimulationMode({
				...change,
				...'activeAddress' in change ? { activeSigningAddress: change.activeAddress } : {}
			})
		}
		const updatedSettings = await getSettings()
		updateWebsiteApprovalAccesses(simulator, websiteTabConnections, undefined, updatedSettings)
		sendPopupMessageToOpenWindows({ method: 'popup_settingsUpdated', data: updatedSettings })
		if (change.rpcNetwork !== undefined) {
			if (change.rpcNetwork.httpsRpc !== undefined) simulator.reset(change.rpcNetwork)
			sendMessageToApprovedWebsitePorts(websiteTabConnections, { method: 'chainChanged' as const, result: change.rpcNetwork.chainId })
			sendPopupMessageToOpenWindows({ method: 'popup_chain_update' })
		}

		sendPopupMessageToOpenWindows({ method: 'popup_accounts_update' })

		if (updatedSettings.simulationMode) {
			// update prepend mode as our active address has changed, so we need to be sure the rich modes money is sent to right address
			const ethereumClientService = simulator.ethereum
			await updateSimulationState(simulator, async () => {
				const simulationState = (await getSimulationResults()).simulationState
				const prependQueue = await getPrependTrasactions(ethereumClientService, await getSettings(), await getMakeMeRich())
				return await setPrependTransactionsQueue(ethereumClientService, simulationState, prependQueue)
			}, updatedSettings.activeSimulationAddress, true)
		}
		// inform website about this only after we have updated simulation, as they often query the balance right after
		sendActiveAccountChangeToApprovedWebsitePorts(websiteTabConnections, await getSettings())
	})
}

export async function changeActiveRpc(simulator: Simulator, websiteTabConnections: WebsiteTabConnections, rpcNetwork: RpcNetwork, simulationMode: boolean) {
	
	if (simulationMode) return await changeActiveAddressAndChainAndResetSimulation(simulator, websiteTabConnections, {
		simulationMode: simulationMode,
		rpcNetwork: rpcNetwork
	})
	sendMessageToApprovedWebsitePorts(websiteTabConnections, { method: 'request_signer_to_wallet_switchEthereumChain', result: rpcNetwork.chainId })
	await sendPopupMessageToOpenWindows({ method: 'popup_settingsUpdated', data: await getSettings() })
}

export async function handleContentScriptMessage(simulator: Simulator, websiteTabConnections: WebsiteTabConnections, request: InterceptedRequest, website: Website, activeAddress: bigint | undefined) {
	try {
		const settings = await getSettings()
		if (settings.simulationMode) {
			const simulationState = (await getSimulationResults()).simulationState
			const resolved = await handleRPCRequest(simulator, simulationState, websiteTabConnections, simulator.ethereum, request.uniqueRequestIdentifier.requestSocket, website, request, settings, activeAddress)
			return replyToInterceptedRequest(websiteTabConnections, { ...request, ...resolved })
		}
		const resolved = await handleRPCRequest(simulator, undefined, websiteTabConnections, simulator.ethereum, request.uniqueRequestIdentifier.requestSocket, website, request, settings, activeAddress)
		return replyToInterceptedRequest(websiteTabConnections, { ...request, ...resolved })
	} catch (error) {
		console.log(request)
		console.warn(error)
		if (error instanceof JsonRpcResponseError || error instanceof FetchResponseError) {
			replyToInterceptedRequest(websiteTabConnections, {
				...request,
				error: {
					code: error.code,
					message: error.message,
					data: JSON.stringify(error.data)
				},
			})
		}
		if (error instanceof Error) {
			if (isFailedToFetchError(error)) {
				return replyToInterceptedRequest(websiteTabConnections, {
					...request,
					...METAMASK_ERROR_NOT_CONNECTED_TO_CHAIN,
				})
			}
		}
		replyToInterceptedRequest(websiteTabConnections, {
			...request,
			error: {
				code: 123456,
				message: 'Unknown error'
			},
		})
		return undefined
	}
}

export function refuseAccess(websiteTabConnections: WebsiteTabConnections, request: InterceptedRequest) {
	return replyToInterceptedRequest(websiteTabConnections, {
		...request,
		error: {
			code: METAMASK_ERROR_NOT_AUTHORIZED,
			message: 'User refused access to the wallet'
		},
	})
}

export async function gateKeepRequestBehindAccessDialog(simulator: Simulator, websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, request: InterceptedRequest, website: Website, activeAddress: bigint | undefined, settings: Settings) {
	const addressInfo = activeAddress !== undefined ? findAddressInfo(activeAddress, settings.userAddressBook.addressInfos) : undefined
	return await requestAccessFromUser(simulator, websiteTabConnections, socket, website, request, addressInfo, settings, activeAddress)
}

export async function popupMessageHandler(
	websiteTabConnections: WebsiteTabConnections,
	simulator: Simulator,
	request: unknown,
	settings: Settings
) {
	const maybeParsedRequest = PopupMessage.safeParse(request)
	if (maybeParsedRequest.success === false) {
		console.log(request)
		console.warn(maybeParsedRequest.fullError)
		return {
			error: {
				message: maybeParsedRequest.fullError === undefined ? 'Unknown parsing error' : maybeParsedRequest.fullError.toString(),
				code: METAMASK_ERROR_FAILED_TO_PARSE_REQUEST,
			}
		}
	}
	const parsedRequest = maybeParsedRequest.value

	switch (parsedRequest.method) {
		case 'popup_confirmDialog': return await confirmDialog(simulator, simulator.ethereum, websiteTabConnections, parsedRequest)
		case 'popup_changeActiveAddress': return await changeActiveAddress(simulator, websiteTabConnections, parsedRequest)
		case 'popup_changeMakeMeRich': return await changeMakeMeRich(simulator, simulator.ethereum, parsedRequest, settings)
		case 'popup_changePage': return await changePage(parsedRequest)
		case 'popup_requestAccountsFromSigner': return await requestAccountsFromSigner(websiteTabConnections, parsedRequest)
		case 'popup_resetSimulation': return await resetSimulation(simulator, simulator.ethereum, settings)
		case 'popup_removeTransaction': return await removeTransaction(simulator, simulator.ethereum, parsedRequest, settings)
		case 'popup_refreshSimulation': return await refreshSimulation(simulator, simulator.ethereum, settings)
		case 'popup_refreshConfirmTransactionDialogSimulation': return await refreshPopupConfirmTransactionSimulation(simulator, simulator.ethereum, parsedRequest)
		case 'popup_refreshConfirmTransactionMetadata': return refreshPopupConfirmTransactionMetadata(simulator.ethereum, settings.userAddressBook, parsedRequest)
		case 'popup_personalSign': return await confirmPersonalSign(websiteTabConnections, parsedRequest)
		case 'popup_interceptorAccess': return await confirmRequestAccess(simulator, websiteTabConnections, parsedRequest)
		case 'popup_changeInterceptorAccess': return await changeInterceptorAccess(simulator, websiteTabConnections, parsedRequest)
		case 'popup_changeActiveRpc': return await popupChangeActiveRpc(simulator, websiteTabConnections, parsedRequest, settings)
		case 'popup_changeChainDialog': return await changeChainDialog(simulator, websiteTabConnections, parsedRequest)
		case 'popup_enableSimulationMode': return await enableSimulationMode(simulator, websiteTabConnections, parsedRequest)
		case 'popup_addOrModifyAddressBookEntry': return await addOrModifyAddressInfo(simulator, websiteTabConnections, parsedRequest)
		case 'popup_getAddressBookData': return await getAddressBookData(parsedRequest, settings.userAddressBook)
		case 'popup_removeAddressBookEntry': return await removeAddressBookEntry(simulator, websiteTabConnections, parsedRequest)
		case 'popup_openAddressBook': return await openAddressBook()
		case 'popup_personalSignReadyAndListening': return await updatePendingPersonalSignViewWithPendingRequests(simulator.ethereum)
		case 'popup_changeChainReadyAndListening': return await updateChainChangeViewWithPendingRequest()
		case 'popup_interceptorAccessReadyAndListening': return await updateInterceptorAccessViewWithPendingRequests()
		case 'popup_confirmTransactionReadyAndListening': return await updateConfirmTransactionViewWithPendingTransaction()
		case 'popup_requestNewHomeData': return await homeOpened(simulator)
		case 'popup_refreshInterceptorAccessMetadata': return await interceptorAccessMetadataRefresh()
		case 'popup_interceptorAccessChangeAddress': return await interceptorAccessChangeAddressOrRefresh(websiteTabConnections, parsedRequest)
		case 'popup_interceptorAccessRefresh': return await interceptorAccessChangeAddressOrRefresh(websiteTabConnections, parsedRequest)
		case 'popup_refreshPersonalSignMetadata': return await updatePendingPersonalSignViewWithPendingRequests(simulator.ethereum)
		case 'popup_ChangeSettings': return await changeSettings(simulator, parsedRequest)
		case 'popup_import_settings': return await importSettings(parsedRequest)
		case 'popup_get_export_settings': return await exportSettings()
		case 'popup_set_rpc_list': return await setNewRpcList(simulator, parsedRequest, settings)
		case 'popup_identifyAddress': return await popupIdentifyAddress(simulator, parsedRequest, settings)
		case 'popup_findAddressBookEntryWithSymbolOrName': return await popupFindAddressBookEntryWithSymbolOrName(parsedRequest, settings)
		default: assertUnreachable(parsedRequest)
	}
}
