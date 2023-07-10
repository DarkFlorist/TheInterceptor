import { ConfirmTransactionTransactionSingleVisualization, InpageScriptRequest, InterceptedRequest, InterceptedRequestForward, InterceptorMessageToInpage, PopupMessage, RPCReply, Settings, TabState } from '../utils/interceptor-messages.js'
import 'webextension-polyfill'
import { Simulator } from '../simulation/simulator.js'
import { EthereumBlockHeader, EthereumJsonRpcRequest, SendRawTransaction, SendTransactionParams } from '../utils/wire-types.js'
import { clearTabStates, getEthDonator, getSignerName, getSimulationResults, removeTabState, setRpcConnectionStatus, updateSimulationResults, updateTabState } from './storageVariables.js'
import { changeSimulationMode, getSettings, getMakeMeRich } from './settings.js'
import { blockNumber, call, chainId, estimateGas, gasPrice, getAccounts, getBalance, getBlockByNumber, getCode, getLogs, getPermissions, getSimulationStack, getTransactionByHash, getTransactionCount, getTransactionReceipt, personalSign, sendRawTransaction, sendTransaction, subscribe, switchEthereumChain, unsubscribe } from './simulationModeHanders.js'
import { changeActiveAddress, changeMakeMeRich, changePage, resetSimulation, confirmDialog, refreshSimulation, removeTransaction, requestAccountsFromSigner, refreshPopupConfirmTransactionSimulation, confirmPersonalSign, confirmRequestAccess, changeInterceptorAccess, changeChainDialog, popupChangeActiveRpc, enableSimulationMode, addOrModifyAddressInfo, getAddressBookData, removeAddressBookEntry, openAddressBook, homeOpened, interceptorAccessChangeAddressOrRefresh, refreshPopupConfirmTransactionMetadata, refreshPersonalSignMetadata, changeSettings, importSettings, exportSettings, setNewRpcList } from './popupMessageHandlers.js'
import { WebsiteCreatedEthereumUnsignedTransaction, SimulationState, RpcEntry, RpcNetwork } from '../utils/visualizer-types.js'
import { AddressBookEntry, Website, TabConnection, WebsiteSocket, WebsiteTabConnections } from '../utils/user-interface-types.js'
import { interceptorAccessMetadataRefresh, requestAccessFromUser } from './windows/interceptorAccess.js'
import { ICON_NOT_ACTIVE, MAKE_YOU_RICH_TRANSACTION, METAMASK_ERROR_FAILED_TO_PARSE_REQUEST, METAMASK_ERROR_NOT_AUTHORIZED, METAMASK_ERROR_NOT_CONNECTED_TO_CHAIN } from '../utils/constants.js'
import { PriceEstimator } from '../simulation/priceEstimator.js'
import { sendActiveAccountChangeToApprovedWebsitePorts, sendMessageToApprovedWebsitePorts, updateWebsiteApprovalAccesses, verifyAccess } from './accessManagement.js'
import { findAddressInfo, getAddressBookEntriesForVisualiser } from './metadataUtils.js'
import { getActiveAddress, getSocketFromPort, sendPopupMessageToOpenWindows, websiteSocketToString } from './backgroundUtils.js'
import { retrieveWebsiteDetails, updateExtensionBadge, updateExtensionIcon } from './iconHandler.js'
import { connectedToSigner, ethAccountsReply, signerChainChanged, walletSwitchEthereumChainReply } from './providerMessageHandlers.js'
import { assertNever, assertUnreachable } from '../utils/typescript.js'
import { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { appendTransaction, copySimulationState, getNonPrependedSimulatedTransactions, getNonceFixedSimulatedTransactions, getWebsiteCreatedEthereumUnsignedTransactions, setPrependTransactionsQueue, setSimulationTransactions } from '../simulation/services/SimulationModeEthereumClientService.js'
import { Semaphore } from '../utils/semaphore.js'
import { FetchResponseError, JsonRpcResponseError, isFailedToFetchError } from '../utils/errors.js'
import { sendSubscriptionMessagesForNewBlock } from '../simulation/services/EthereumSubscriptionService.js'
import { formSimulatedAndVisualizedTransaction } from '../components/formVisualizerResults.js'

const websiteTabConnections = new Map<number, TabConnection>()

browser.runtime.onConnect.addListener(port => onContentScriptConnected(port, websiteTabConnections).catch(console.error))
browser.tabs.onRemoved.addListener((tabId: number) => removeTabState(tabId))

if (browser.runtime.getManifest().manifest_version === 2) {
	clearTabStates()
}

let simulator: Simulator | undefined = undefined

async function visualizeSimulatorState(simulationState: SimulationState, simulator: Simulator) {
	const priceEstimator = new PriceEstimator(simulator.ethereum)
	const transactions = getWebsiteCreatedEthereumUnsignedTransactions(simulationState.simulatedTransactions)
	const visualizerResult = await simulator.visualizeTransactionChain(simulationState, transactions, simulationState.blockNumber, simulationState.simulatedTransactions.map((x) => x.multicallResponse))
	const visualizerResults = visualizerResult.map((x, i) => ({ ...x, website: simulationState.simulatedTransactions[i].website }))
	const addressBookEntries = await getAddressBookEntriesForVisualiser(simulator.ethereum, visualizerResult.map((x) => x.visualizerResults), simulationState, (await getSettings()).userAddressBook)
	const simulatedAndVisualizedTransactions = formSimulatedAndVisualizedTransaction(simulationState, visualizerResults, addressBookEntries)

	function onlyTokensAndTokensWithKnownDecimals(metadata: AddressBookEntry): metadata is AddressBookEntry & { type: 'token', decimals: `0x${string}` } {
		if (metadata.type !== 'token') return false
		if (metadata.decimals === undefined) return false
		return true
	}
	function metadataRestructure(metadata: AddressBookEntry & { type: 'token', decimals: bigint }) {
		return { token: metadata.address, decimals: metadata.decimals }
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

export async function updateSimulationState(getUpdatedSimulationState: () => Promise<SimulationState | undefined>, activeAddress: bigint | undefined) {
	if (simulator === undefined) return
	const simId = (await getSimulationResults()).simulationId + 1
	try {
		const updatedSimulationState = await getUpdatedSimulationState()
		if (updatedSimulationState !== undefined) {
			await updateSimulationResults({
				simulationId: simId,
				...await visualizeSimulatorState(updatedSimulationState, simulator),
				activeAddress: activeAddress,
			})
		} else {
			await updateSimulationResults({
				simulationId: simId,
				addressBookEntries: [],
				tokenPrices: [],
				visualizerResults: [],
				simulationState: updatedSimulationState,
				activeAddress: activeAddress,
			})
		}
		sendPopupMessageToOpenWindows({ method: 'popup_simulation_state_changed' })
		return updatedSimulationState
	} catch (error) {
		if (error instanceof Error) {
			if (isFailedToFetchError(error)) {
				await sendPopupMessageToOpenWindows({ method: 'popup_failed_to_update_simulation_state' })
				return undefined
			}
		}
		throw error
	}
}

export function setEthereumNodeBlockPolling(enabled: boolean) {
	if (simulator === undefined) return
	simulator.ethereum.setBlockPolling(enabled)
}

export async function refreshConfirmTransactionSimulation(
	ethereumClientService: EthereumClientService,
	activeAddress: bigint,
	simulationMode: boolean,
	requestId: number,
	transactionToSimulate: WebsiteCreatedEthereumUnsignedTransaction,
	tabIdOpenedFrom: number,
): Promise<ConfirmTransactionTransactionSingleVisualization> {
	const info = {
		requestId: requestId,
		transactionToSimulate: transactionToSimulate,
		simulationMode: simulationMode,
		activeAddress: activeAddress,
		signerName: await getSignerName(),
		tabIdOpenedFrom,
	}
	if (simulator === undefined) return { statusCode: 'failed', data: info } as const
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
export async function getPrependTrasactions(ethereumClientService: EthereumClientService, settings: Settings, richMode: boolean) {
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
		transactionSendingFormat: MAKE_YOU_RICH_TRANSACTION.transactionSendingFormat,
	}]
}

async function handleRPCRequest(
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
	if (maybeParsedRequest.success === false) {
		console.log(request)
		console.warn(maybeParsedRequest.fullError)
		return {
			method: request.method,
			error: {
				message: maybeParsedRequest.fullError === undefined ? 'Failed to parse RPC request ' : maybeParsedRequest.fullError.toString(),
				code: METAMASK_ERROR_FAILED_TO_PARSE_REQUEST,
			}
		}
	}
	const getForwardingMessage = (request: SendRawTransaction | SendTransactionParams) => {
		if (!forwardToSigner) throw new Error('Should not forward to signer')
		return { forward: true as const, ...request }
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
		case 'net_version': return await chainId(ethereumClientService)
		case 'eth_getCode': return await getCode(ethereumClientService, simulationState, parsedRequest)
		case 'personal_sign':
		case 'eth_signTypedData':
		case 'eth_signTypedData_v1':
		case 'eth_signTypedData_v2':
		case 'eth_signTypedData_v3':
		case 'eth_signTypedData_v4': return await personalSign(ethereumClientService, websiteTabConnections, socket, parsedRequest, request, settings.simulationMode, website, settings, activeAddress)
		case 'wallet_switchEthereumChain': return await switchEthereumChain(websiteTabConnections, socket, ethereumClientService, parsedRequest, request, settings.simulationMode, website)
		case 'wallet_requestPermissions': return await getAccounts(activeAddress)
		case 'wallet_getPermissions': return await getPermissions()
		case 'eth_accounts': return await getAccounts(activeAddress)
		case 'eth_requestAccounts': return await getAccounts(activeAddress)
		case 'eth_gasPrice': return await gasPrice(ethereumClientService)
		case 'eth_getTransactionCount': return await getTransactionCount(ethereumClientService, simulationState, parsedRequest)
		case 'interceptor_getSimulationStack': return await getSimulationStack(simulationState, parsedRequest)
		case 'eth_multicall': return { method: parsedRequest.method, error: { code: 10000, message: 'Cannot call eth_multicall directly' } }
		case 'eth_getStorageAt': return { method: parsedRequest.method, error: { code: 10000, message: 'eth_getStorageAt not implemented' } }
		case 'eth_getLogs': return await getLogs(ethereumClientService, simulationState, parsedRequest)
		case 'eth_sign': return { method: parsedRequest.method, error: { code: 10000, message: 'eth_sign is deprecated' } }
		case 'eth_sendRawTransaction': {
			if (forwardToSigner && settings.rpcNetwork.httpsRpc === undefined) return getForwardingMessage(parsedRequest)
			const message = await sendRawTransaction(ethereumClientService, parsedRequest, socket, request, !forwardToSigner, website, activeAddress)
			if ('forward' in message) return getForwardingMessage(parsedRequest)
			return message
		}
		case 'eth_sendTransaction': {
			if (forwardToSigner && settings.rpcNetwork.httpsRpc === undefined) return getForwardingMessage(parsedRequest)
			const message = await sendTransaction(websiteTabConnections, activeAddress, ethereumClientService, parsedRequest, socket, request, !forwardToSigner, website)
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

async function newBlockAttemptCallback(blockheader: EthereumBlockHeader, ethereumClientService: EthereumClientService, isNewBlock: boolean) {
	const rpcConnectionStatus = {
		isConnected: true,
		lastConnnectionAttempt: new Date(),
		latestBlock: blockheader,
		rpcNetwork: ethereumClientService.getRpcNetwork(),
	}
	await setRpcConnectionStatus(rpcConnectionStatus)
	await updateExtensionBadge()
	await sendPopupMessageToOpenWindows({ method: 'popup_new_block_arrived', data: { rpcConnectionStatus } })
	if (isNewBlock) {
		const settings = await getSettings()
		await sendSubscriptionMessagesForNewBlock(blockheader.number, ethereumClientService, settings.simulationMode ? await refreshSimulation(ethereumClientService, settings) : undefined, websiteTabConnections)
	}
}

async function onErrorBlockCallback(ethereumClientService: EthereumClientService, error: Error) {
	if (isFailedToFetchError(error)) {
		const rpcConnectionStatus = {
			isConnected: false,
			lastConnnectionAttempt: new Date(),
			latestBlock: ethereumClientService.getLastKnownCachedBlockOrUndefined(),
			rpcNetwork: ethereumClientService.getRpcNetwork(),
		}
		await setRpcConnectionStatus(rpcConnectionStatus)
		await updateExtensionBadge()
		return await sendPopupMessageToOpenWindows({ method: 'popup_failed_to_get_block', data: { rpcConnectionStatus } })
	}
	throw error
}


export async function resetSimulator(entry: RpcEntry) {
	if (simulator !== undefined) simulator.cleanup()
	simulator = new Simulator(entry, newBlockAttemptCallback, onErrorBlockCallback)
}

const changeActiveAddressAndChainAndResetSimulationSemaphore = new Semaphore(1)
export async function changeActiveAddressAndChainAndResetSimulation(
	websiteTabConnections: WebsiteTabConnections,
	change: {
		simulationMode: boolean,
		activeAddress?: bigint,
		rpcNetwork?: RpcNetwork,
	},
) {
	await changeActiveAddressAndChainAndResetSimulationSemaphore.execute(async () => {
		if (simulator === undefined) return

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
		updateWebsiteApprovalAccesses(websiteTabConnections, undefined, updatedSettings)
		sendPopupMessageToOpenWindows({ method: 'popup_settingsUpdated', data: updatedSettings })
		if (change.rpcNetwork !== undefined) {
			if (change.rpcNetwork.httpsRpc !== undefined) await resetSimulator(change.rpcNetwork)
			sendMessageToApprovedWebsitePorts(websiteTabConnections, { method: 'chainChanged' as const, result: change.rpcNetwork.chainId })
			sendPopupMessageToOpenWindows({ method: 'popup_chain_update' })
		}

		sendPopupMessageToOpenWindows({ method: 'popup_accounts_update' })

		if (updatedSettings.simulationMode) {
			// update prepend mode as our active address has changed, so we need to be sure the rich modes money is sent to right address
			const ethereumClientService = simulator.ethereum
			await updateSimulationState(async () => {
				const simulationState = (await getSimulationResults()).simulationState
				const prependQueue = await getPrependTrasactions(ethereumClientService, await getSettings(), await getMakeMeRich())
				return await setPrependTransactionsQueue(ethereumClientService, simulationState, prependQueue)
			}, updatedSettings.activeSimulationAddress)
		}
		// inform website about this only after we have updated simulation, as they often query the balance right after
		sendActiveAccountChangeToApprovedWebsitePorts(websiteTabConnections, await getSettings())
	})
}

export async function changeActiveRpc(websiteTabConnections: WebsiteTabConnections, rpcNetwork: RpcNetwork, simulationMode: boolean) {
	if (simulationMode) return await changeActiveAddressAndChainAndResetSimulation(websiteTabConnections, {
		simulationMode: simulationMode,
		rpcNetwork: rpcNetwork
	})
	sendMessageToApprovedWebsitePorts(websiteTabConnections, { method: 'request_signer_to_wallet_switchEthereumChain', result: rpcNetwork.chainId })
	await sendPopupMessageToOpenWindows({ method: 'popup_settingsUpdated', data: await getSettings() })
}

export function postMessageToPortIfConnected(port: browser.runtime.Port, message: InterceptedRequestForward) {
	try {
		port.postMessage(InterceptorMessageToInpage.serialize({ interceptorApproved: true, ...message }) as Object)
	} catch (error) {
		if (error instanceof Error) {
			if (error.message?.includes('Attempting to use a disconnected port object')) {
				return
			}
			if (error.message?.includes('Could not establish connection. Receiving end does not exist')) {
				return
			}
		}
		throw error
	}
}
export function postMessageIfStillConnected(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, message: InterceptedRequestForward) {
	const tabConnection = websiteTabConnections.get(socket.tabId)
	const identifier = websiteSocketToString(socket)
	if (tabConnection === undefined) return false
	for (const [socketAsString, connection] of Object.entries(tabConnection.connections)) {
		if (socketAsString !== identifier) continue
		postMessageToPortIfConnected(connection.port, message)
	}
	return true
}

export async function handleContentScriptMessage(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, request: InterceptedRequest, website: Website, activeAddress: bigint | undefined) {
	try {
		if (simulator === undefined) throw 'Interceptor not ready'
		const settings = await getSettings()
		if (settings.simulationMode) {
			const simulationState = (await getSimulationResults()).simulationState
			if (simulationState === undefined) throw new Error('no simulation state')
			const resolved = await handleRPCRequest(simulationState, websiteTabConnections, simulator.ethereum, socket, website, request, settings, activeAddress)
			return postMessageIfStillConnected(websiteTabConnections, socket, { ...request, ...resolved })
		}
		const resolved = await handleRPCRequest(undefined, websiteTabConnections, simulator.ethereum, socket, website, request, settings, activeAddress)
		return postMessageIfStillConnected(websiteTabConnections, socket, { ...request, ...resolved })
	} catch (error) {
		console.log(request)
		console.warn(error)
		if (error instanceof JsonRpcResponseError || error instanceof FetchResponseError) {
			postMessageIfStillConnected(websiteTabConnections, socket, {
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
				return postMessageIfStillConnected(websiteTabConnections, socket, {
					...request,
					...METAMASK_ERROR_NOT_CONNECTED_TO_CHAIN,
				})
			}
		}
		postMessageIfStillConnected(websiteTabConnections, socket, {
			...request,
			error: {
				code: 123456,
				message: 'Unknown error'
			},
		})
		return undefined
	}
}

export function refuseAccess(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, request: InterceptedRequest) {
	return postMessageIfStillConnected(websiteTabConnections, socket, {
		...request,
		error: {
			code: METAMASK_ERROR_NOT_AUTHORIZED,
			message: 'User refused access to the wallet'
		},
	})
}

export async function gateKeepRequestBehindAccessDialog(socket: WebsiteSocket, request: InterceptedRequest, website: Website, activeAddress: bigint | undefined, settings: Settings) {
	const addressInfo = activeAddress !== undefined ? findAddressInfo(activeAddress, settings.userAddressBook.addressInfos) : undefined
	return await requestAccessFromUser(websiteTabConnections, socket, website, request, addressInfo, settings, activeAddress)
}

function getProviderHandler(method: string) {
	switch (method) {
		case 'eth_accounts_reply': return { method: 'eth_accounts_reply' as const, func: ethAccountsReply }
		case 'signer_chainChanged': return { method: 'signer_chainChanged' as const, func: signerChainChanged }
		case 'wallet_switchEthereumChain_reply': return { method: 'wallet_switchEthereumChain_reply' as const, func: walletSwitchEthereumChainReply }
		case 'connected_to_signer': return { method: 'connected_to_signer' as const, func: connectedToSigner }
		default: return { method: 'notProviderMethod' as const }
	}
}

async function onContentScriptConnected(port: browser.runtime.Port, websiteTabConnections: WebsiteTabConnections) {
	const socket = getSocketFromPort(port)
	if (port?.sender?.url === undefined) return
	const websiteOrigin = (new URL(port.sender.url)).hostname
	const websitePromise = retrieveWebsiteDetails(port, websiteOrigin)
	const identifier = websiteSocketToString(socket)

	console.log(`content script connected ${ websiteOrigin }`)

	const tabConnection = websiteTabConnections.get(socket.tabId)
	const newConnection = {
		port: port,
		socket: socket,
		websiteOrigin: websiteOrigin,
		approved: false,
		wantsToConnect: false,
	}
	port.onDisconnect.addListener(() => {
		const tabConnection = websiteTabConnections.get(socket.tabId)
		if (tabConnection === undefined) return
		delete tabConnection.connections[websiteSocketToString(socket)]
		if (Object.keys(tabConnection).length === 0) {
			websiteTabConnections.delete(socket.tabId)
		}
	})

	const pendingRequestLimiter = new Semaphore(20) // only allow 20 requests pending at the time for a port

	port.onMessage.addListener(async (payload) => {
		if (!(
			'data' in payload
			&& typeof payload.data === 'object'
			&& payload.data !== null
			&& 'interceptorRequest' in payload.data
		)) return
		await pendingRequestLimiter.execute(async () => {
			const request = InterceptedRequest.parse(payload.data)
			const activeAddress = await getActiveAddress(await getSettings(), socket.tabId)
			const access = verifyAccess(websiteTabConnections, socket, request.method === 'eth_requestAccounts', websiteOrigin, activeAddress, await getSettings())
			const providerHandler = getProviderHandler(request.method)
			const identifiedMethod = providerHandler.method
			if (identifiedMethod !== 'notProviderMethod') {
				await providerHandler.func(websiteTabConnections, port, request, access)
				const message: InpageScriptRequest = {
					requestId: request.requestId,
					method: identifiedMethod,
					result: '0x' as const,
				}
				return postMessageIfStillConnected(websiteTabConnections, socket, message)
			}
			if (access === 'noAccess' || activeAddress === undefined) {
				if (request.method === 'eth_accounts') {
					return postMessageIfStillConnected(websiteTabConnections, socket, { method: 'eth_accounts' as const, result: [], requestId: request.requestId })
				}
				// if user has not given access, assume we are on chain 1
				if (request.method === 'eth_chainId' || request.method === 'net_version') {
					return postMessageIfStillConnected(websiteTabConnections, socket, { method: 'eth_chainId' as const, result: 1n, requestId: request.requestId })
				}
			}
			if (activeAddress === undefined) return refuseAccess(websiteTabConnections, socket, request)

			switch (access) {
				case 'noAccess': return refuseAccess(websiteTabConnections, socket, request)
				case 'askAccess': return await gateKeepRequestBehindAccessDialog(socket, request, await websitePromise, activeAddress, await getSettings())
				case 'hasAccess': return await handleContentScriptMessage(websiteTabConnections, socket, request, await websitePromise, activeAddress)
				default: assertNever(access)
			}
		})
	})

	if (tabConnection === undefined) {
		websiteTabConnections.set(socket.tabId, {
			connections: { [identifier]: newConnection },
		})
		await updateTabState(socket.tabId, (previousState: TabState) => {
			return {
				...previousState,
				tabIconDetails: {
					icon: ICON_NOT_ACTIVE,
					iconReason: 'No active address selected.',
				}
			}
		})
		updateExtensionIcon(websiteTabConnections, socket, websiteOrigin)
	} else {
		tabConnection.connections[identifier] = newConnection
	}

}

async function popupMessageHandler(
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
		case 'popup_confirmDialog': return await confirmDialog(simulator.ethereum, websiteTabConnections, parsedRequest)
		case 'popup_changeActiveAddress': return await changeActiveAddress(websiteTabConnections, parsedRequest)
		case 'popup_changeMakeMeRich': return await changeMakeMeRich(simulator.ethereum, parsedRequest, settings)
		case 'popup_changePage': return await changePage(parsedRequest)
		case 'popup_requestAccountsFromSigner': return await requestAccountsFromSigner(websiteTabConnections, parsedRequest)
		case 'popup_resetSimulation': return await resetSimulation(simulator.ethereum, settings)
		case 'popup_removeTransaction': return await removeTransaction(simulator.ethereum, parsedRequest, settings)
		case 'popup_refreshSimulation': return await refreshSimulation(simulator.ethereum, settings)
		case 'popup_refreshConfirmTransactionDialogSimulation': return await refreshPopupConfirmTransactionSimulation(simulator.ethereum, parsedRequest)
		case 'popup_refreshConfirmTransactionMetadata': return refreshPopupConfirmTransactionMetadata(simulator.ethereum, settings.userAddressBook, parsedRequest)
		case 'popup_personalSign': return await confirmPersonalSign(websiteTabConnections, parsedRequest)
		case 'popup_interceptorAccess': return await confirmRequestAccess(websiteTabConnections, parsedRequest)
		case 'popup_changeInterceptorAccess': return await changeInterceptorAccess(websiteTabConnections, parsedRequest)
		case 'popup_changeActiveRpc': return await popupChangeActiveRpc(websiteTabConnections, parsedRequest, settings)
		case 'popup_changeChainDialog': return await changeChainDialog(websiteTabConnections, parsedRequest)
		case 'popup_enableSimulationMode': return await enableSimulationMode(websiteTabConnections, parsedRequest)
		case 'popup_addOrModifyAddressBookEntry': return await addOrModifyAddressInfo(websiteTabConnections, parsedRequest)
		case 'popup_getAddressBookData': return await getAddressBookData(parsedRequest, settings.userAddressBook)
		case 'popup_removeAddressBookEntry': return await removeAddressBookEntry(websiteTabConnections, parsedRequest)
		case 'popup_openAddressBook': return await openAddressBook()
		case 'popup_personalSignReadyAndListening': return // handled elsewhere (personalSign.ts)
		case 'popup_changeChainReadyAndListening': return // handled elsewhere (changeChain.ts)
		case 'popup_interceptorAccessReadyAndListening': return // handled elsewhere (interceptorAccess.ts)
		case 'popup_confirmTransactionReadyAndListening': return // handled elsewhere (confirmTransaction.ts)
		case 'popup_requestNewHomeData': return homeOpened(simulator)
		case 'popup_refreshInterceptorAccessMetadata': return await interceptorAccessMetadataRefresh()
		case 'popup_interceptorAccessChangeAddress': return await interceptorAccessChangeAddressOrRefresh(websiteTabConnections, parsedRequest)
		case 'popup_interceptorAccessRefresh': return await interceptorAccessChangeAddressOrRefresh(websiteTabConnections, parsedRequest)
		case 'popup_refreshPersonalSignMetadata': return await refreshPersonalSignMetadata(simulator.ethereum, parsedRequest, settings)
		case 'popup_ChangeSettings': return await changeSettings(simulator, parsedRequest)
		case 'popup_import_settings': return await importSettings(parsedRequest)
		case 'popup_get_export_settings': return await exportSettings()
		case 'popup_set_rpc_list': return await setNewRpcList(parsedRequest, settings)
		default: assertUnreachable(parsedRequest)
	}
}

async function startup() {
	const settings = await getSettings()
	if (settings.rpcNetwork.httpsRpc !== undefined) await resetSimulator(settings.rpcNetwork)
	if (simulator === undefined) throw new Error('simulator not found')
	browser.runtime.onMessage.addListener(async function (message: unknown) {
		if (simulator === undefined) throw new Error('Interceptor not ready yet')
		await popupMessageHandler(websiteTabConnections, simulator, message, await getSettings())
	})

	await updateExtensionBadge()

	if (settings.simulationMode) {
		// update prepend mode as our active address has changed, so we need to be sure the rich modes money is sent to right address
		const ethereumClientService = simulator.ethereum
		await updateSimulationState(async () => {
			const simulationState = (await getSimulationResults()).simulationState
			const prependQueue = await getPrependTrasactions(ethereumClientService, settings, await getMakeMeRich())
			return await setPrependTransactionsQueue(ethereumClientService, simulationState, prependQueue)
		}, settings.activeSimulationAddress)
	}
}

startup()
