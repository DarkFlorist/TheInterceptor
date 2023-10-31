import { PopupMessage, RPCReply, Settings } from '../types/interceptor-messages.js'
import 'webextension-polyfill'
import { Simulator, runProtectorsForTransaction, visualizeTransaction } from '../simulation/simulator.js'
import { getEthDonator, getSignerName, getSimulationResults, updateSimulationResults, updateSimulationResultsWithCallBack } from './storageVariables.js'
import { changeSimulationMode, getSettings, getMakeMeRich } from './settings.js'
import { blockNumber, call, chainId, estimateGas, gasPrice, getAccounts, getBalance, getBlockByNumber, getCode, getLogs, getPermissions, getSimulationStack, getTransactionByHash, getTransactionCount, getTransactionReceipt, netVersion, personalSign, sendTransaction, subscribe, switchEthereumChain, unsubscribe, web3ClientVersion, getBlockByHash } from './simulationModeHanders.js'
import { changeActiveAddress, changeMakeMeRich, changePage, resetSimulation, confirmDialog, refreshSimulation, removeTransaction, requestAccountsFromSigner, refreshPopupConfirmTransactionSimulation, confirmPersonalSign, confirmRequestAccess, changeInterceptorAccess, changeChainDialog, popupChangeActiveRpc, enableSimulationMode, addOrModifyAddressBookEntry, getAddressBookData, removeAddressBookEntry, openAddressBook, homeOpened, interceptorAccessChangeAddressOrRefresh, refreshPopupConfirmTransactionMetadata, changeSettings, importSettings, exportSettings, setNewRpcList, popupIdentifyAddress, popupFindAddressBookEntryWithSymbolOrName, removeSignedMessage, simulateGovernanceContractExecutionOnPass, fetchAbiAndNameFromEtherScan } from './popupMessageHandlers.js'
import { ProtectorResults, SimulationState, VisualizedSimulatorState, VisualizerResult, WebsiteCreatedEthereumUnsignedTransaction } from '../types/visualizer-types.js'
import { WebsiteTabConnections } from '../types/user-interface-types.js'
import { interceptorAccessMetadataRefresh, requestAccessFromUser, updateInterceptorAccessViewWithPendingRequests } from './windows/interceptorAccess.js'
import { FourByteExplanations, MAKE_YOU_RICH_TRANSACTION, METAMASK_ERROR_FAILED_TO_PARSE_REQUEST, METAMASK_ERROR_NOT_AUTHORIZED, METAMASK_ERROR_NOT_CONNECTED_TO_CHAIN } from '../utils/constants.js'
import { PriceEstimator } from '../simulation/priceEstimator.js'
import { sendActiveAccountChangeToApprovedWebsitePorts, sendMessageToApprovedWebsitePorts, updateWebsiteApprovalAccesses } from './accessManagement.js'
import { getActiveAddressEntry, getAddressBookEntriesForVisualiser, identifyAddress, nameTokenIds } from './metadataUtils.js'
import { sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { assertUnreachable } from '../utils/typescript.js'
import { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { appendTransaction, calculateGasPrice, copySimulationState, getNonPrependedSimulatedTransactions, getNonceFixedSimulatedTransactions, getTokenBalancesAfter, getWebsiteCreatedEthereumUnsignedTransactions, mockSignTransaction, setPrependTransactionsQueue, setSimulationTransactionsAndSignedMessages } from '../simulation/services/SimulationModeEthereumClientService.js'
import { Semaphore } from '../utils/semaphore.js'
import { FetchResponseError, JsonRpcResponseError, isFailedToFetchError } from '../utils/errors.js'
import { formSimulatedAndVisualizedTransaction } from '../components/formVisualizerResults.js'
import { updateConfirmTransactionViewWithPendingTransaction } from './windows/confirmTransaction.js'
import { updateChainChangeViewWithPendingRequest } from './windows/changeChain.js'
import { craftPersonalSignPopupMessage, updatePendingPersonalSignViewWithPendingRequests } from './windows/personalSign.js'
import { InterceptedRequest, UniqueRequestIdentifier, WebsiteSocket } from '../utils/requests.js'
import { replyToInterceptedRequest } from './messageSending.js'
import { EthGetStorageAtParams, EthereumJsonRpcRequest, SendRawTransactionParams, SendTransactionParams, SupportedEthereumJsonRpcRequestMethods, WalletAddEthereumChain } from '../types/JsonRpc-types.js'
import { AddressBookEntry, UserAddressBook } from '../types/addressBookTypes.js'
import { Website } from '../types/websiteAccessTypes.js'
import { ConfirmTransactionTransactionSingleVisualization, PendingTransaction } from '../types/accessRequest.js'
import { RpcNetwork } from '../types/rpc.js'
import { serialize } from '../types/wire-types.js'
import { get4Byte } from '../utils/calldata.js'
import { simulateCompoundGovernanceExecution } from '../simulation/compoundGovernanceFaking.js'
import { Interface } from 'ethers'
import { CompoundGovernanceAbi } from '../utils/abi.js'
import { dataStringWith0xStart } from '../utils/bigint.js'

async function updateMetadataForSimulation(simulationState: SimulationState, ethereum: EthereumClientService, visualizerResults: readonly VisualizerResult[], protectorResults: readonly ProtectorResults[]) {
	const settingsPromise = getSettings()
	const signerPromise = getSignerName()
	const settings = await settingsPromise
	const signerName = await signerPromise
	const addressBookEntryPromises = getAddressBookEntriesForVisualiser(ethereum, visualizerResults, simulationState, settings.userAddressBook)
	const namedTokenIdPromises = nameTokenIds(ethereum, visualizerResults)
	const addressBookEntries = await addressBookEntryPromises
	const namedTokenIds = await namedTokenIdPromises
	const simulatedAndVisualizedTransactions = formSimulatedAndVisualizedTransaction(simulationState, visualizerResults, protectorResults, addressBookEntries, namedTokenIds)
	const VisualizedPersonalSignRequest = simulationState.signedMessages.map((signedMessage) => craftPersonalSignPopupMessage(ethereum, signedMessage, signerName, settings.rpcNetwork, settings.userAddressBook))
	return {
		namedTokenIds,
		addressBookEntries: addressBookEntries,
		simulatedAndVisualizedTransactions,
		visualizedPersonalSignRequests: await Promise.all(VisualizedPersonalSignRequest),
	}
}

export const simulateGovernanceContractExecution = async (pendingTransaction: PendingTransaction, ethereum: EthereumClientService, userAddressBook: UserAddressBook) => {
	const returnError = (text: string) => ({ error: { type: 'Other' as const, message: text } })
	try {
		// identifies compound governane call and performs simulation if the vote passes
		const pendingResults = pendingTransaction.simulationResults
		if (pendingResults.statusCode !== 'success') return returnError('Voting transaction failed')
		const fourByte = get4Byte(pendingTransaction.transactionToSimulate.transaction.input)
		if (fourByte === undefined) return returnError('Could not identify the 4byte signature')
		const explanation = FourByteExplanations[fourByte]
		if ((explanation !== 'Submit vote' && explanation !== 'Cast vote') || pendingResults.data.simulatedAndVisualizedTransactions[0]?.events.length !== 1) return returnError('Could not identify the transaction as a vote')
		
		if (pendingTransaction.transactionToSimulate.transaction.to === null) return returnError('The transaction creates a contract instead of casting a vote')
		const governanceContractInterface = new Interface(CompoundGovernanceAbi)
		const params = governanceContractInterface.decodeFunctionData(explanation === 'Submit vote' ? 'submitVote' : 'castVote', dataStringWith0xStart(pendingTransaction.transactionToSimulate.transaction.input))
		const addr = await identifyAddress(ethereum, userAddressBook, pendingTransaction.transactionToSimulate.transaction.to)
		if (!('abi' in addr) || addr.abi === undefined) return { error: { type: 'MissingAbi' as const, message: 'ABi for the governance contract is missing', addressBookEntry: addr } }
		const contractExecutionResult = await simulateCompoundGovernanceExecution(ethereum, addr, params[0])
		if (contractExecutionResult === undefined) return returnError('Failed to simulate governacne execution')
		const parentBlock = await ethereum.getBlock()
		if (parentBlock.baseFeePerGas === undefined) return returnError('cannot build simulation from legacy block')
		const signedExecutionTransaction = mockSignTransaction({ ...contractExecutionResult.executingTransaction, gas: contractExecutionResult.multicallResult.gasSpent })
		const tokenBalancesAfter = await getTokenBalancesAfter(
			ethereum,
			[signedExecutionTransaction],
			[],
			[contractExecutionResult.multicallResult],
			parentBlock.number
		)

		if (tokenBalancesAfter[0] === undefined) return returnError('Could not compute token balances')

		const governanceContractSimulationState: SimulationState =  {
			prependTransactionsQueue: [],
			simulatedTransactions: [{
				multicallResponse: contractExecutionResult.multicallResult,
				signedTransaction: signedExecutionTransaction,
				realizedGasPrice: calculateGasPrice(signedExecutionTransaction, parentBlock.gasUsed, parentBlock.gasLimit, parentBlock.baseFeePerGas),
				tokenBalancesAfter: tokenBalancesAfter[0],
				website: pendingTransaction.transactionToSimulate.website,
				created: new Date(),
				originalRequestParameters: pendingTransaction.transactionToSimulate.originalRequestParameters,
			}],
			blockNumber: parentBlock.number,
			blockTimestamp: parentBlock.timestamp,
			rpcNetwork: ethereum.getRpcNetwork(),
			simulationConductedTimestamp: new Date(),
			signedMessages: [],
		}
		return await visualizeSimulatorState(governanceContractSimulationState, ethereum)
	} catch(error) {
		console.warning(error)
		if (error instanceof Error) return returnError(error.message)
		throw error
	}
}

async function visualizeSimulatorState(simulationState: SimulationState, ethereum: EthereumClientService): Promise<VisualizedSimulatorState> {
	const priceEstimator = new PriceEstimator(ethereum)
	const transactions = getWebsiteCreatedEthereumUnsignedTransactions(simulationState.simulatedTransactions)

	const blockNum = await ethereum.getBlockNumber()
	const visualizerResults = simulationState.simulatedTransactions.map((simulatedTransaction) => visualizeTransaction(blockNum, simulatedTransaction.multicallResponse))
	const protectorPromises = Promise.all(transactions.map(async (transaction) => await runProtectorsForTransaction(simulationState, transaction, ethereum)))
	
	const protectors = await protectorPromises
	const updatedMetadataPromise = updateMetadataForSimulation(simulationState, ethereum, visualizerResults, protectors)

	function onlyTokensAndTokensWithKnownDecimals(metadata: AddressBookEntry): metadata is AddressBookEntry & { type: 'ERC20', decimals: `0x${ string }` } {
		if (metadata.type !== 'ERC20') return false
		if (metadata.decimals === undefined) return false
		return true
	}
	function metadataRestructure(metadata: AddressBookEntry & { type: 'ERC20', decimals: bigint }) {
		return { address: metadata.address, decimals: metadata.decimals }
	}
	const updatedMetadata = await updatedMetadataPromise
	const tokenPricePromises = priceEstimator.estimateEthereumPricesForTokens(updatedMetadata.addressBookEntries.filter(onlyTokensAndTokensWithKnownDecimals).map(metadataRestructure))

	return {
		...updatedMetadata,
		tokenPrices: await tokenPricePromises,
		visualizerResults,
		protectors,
		simulationState,
	}
}

export const updateSimulationMetadata = async (ethereum: EthereumClientService) => {
	return await updateSimulationResultsWithCallBack(async (prevState) => {
		if (prevState?.simulationState === undefined) return prevState
		const metadata = await updateMetadataForSimulation(prevState.simulationState, ethereum, prevState.visualizerResults, prevState.protectors)
		return { ...prevState, ...metadata }
	})
}

const updateSimulationStateSemaphore = new Semaphore(1)
export async function updateSimulationState(ethereum: EthereumClientService, getUpdatedSimulationState: (simulationState: SimulationState | undefined) => Promise<SimulationState | undefined>, activeAddress: bigint | undefined, invalidateOldState: boolean) {
	return await updateSimulationStateSemaphore.execute(async () => {
		const simulationResults = await getSimulationResults()
		const simulationId = simulationResults.simulationId + 1
		if (invalidateOldState) {
			await updateSimulationResults({ ...simulationResults, simulationId, simulationResultState: 'invalid', simulationUpdatingState: 'updating' })
		} else {
			await updateSimulationResults({ ...simulationResults, simulationId, simulationUpdatingState: 'updating' })
		}
		const changedMessagePromise = sendPopupMessageToOpenWindows({ method: 'popup_simulation_state_changed', data: { simulationId } })
		try {
			const updatedSimulationState = await getUpdatedSimulationState(simulationResults.simulationState)
			const doneState = { simulationUpdatingState: 'done' as const, simulationResultState: 'done' as const, simulationId, activeAddress }
			if (updatedSimulationState !== undefined) { 
				await updateSimulationResults({ ...await visualizeSimulatorState(updatedSimulationState, ethereum), ...doneState })
			} else {
				await updateSimulationResults({
					...doneState,
					addressBookEntries: [],
					tokenPrices: [],
					visualizerResults: [],
					protectors: [],
					namedTokenIds: [],
					simulationState: updatedSimulationState,
					simulatedAndVisualizedTransactions: [],
					visualizedPersonalSignRequests: [],
				})
			}
			await changedMessagePromise
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
				data: { ...info, ...await visualizeSimulatorState(simulationStateWithNewTransaction, simulator.ethereum) }
			}
		}
		const noncefixedNotPrepended = getWebsiteCreatedEthereumUnsignedTransactions(getNonPrependedSimulatedTransactions(simulationStateWithNewTransaction.prependTransactionsQueue, noncefixed))
		const nonceFixedState = await setSimulationTransactionsAndSignedMessages(ethereumClientService, simulationStateWithNewTransaction, noncefixedNotPrepended, simulationStateWithNewTransaction.signedMessages)
		const lastNonceFixed = noncefixed[noncefixed.length - 1]
		if (lastNonceFixed === undefined) throw new Error('last nonce fixed was undefined')
		return {
			statusCode: 'success' as const,
			data: {
				...info,
				...await visualizeSimulatorState(nonceFixedState, simulator.ethereum),
				transactionToSimulate: {
					...transactionToSimulate,
					transaction: {
						...transactionToSimulate.transaction,
						nonce: lastNonceFixed.signedTransaction.nonce,
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
		created: new Date(),
		originalRequestParameters: { method: MAKE_YOU_RICH_TRANSACTION.transactionSendingFormat, params: [{}] },
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
				message: `Failed to parse RPC request: ${ serialize(InterceptedRequest, request) }`,
				data: maybeParsedRequest.fullError === undefined ? 'Failed to parse RPC request' : maybeParsedRequest.fullError.toString(),
				code: METAMASK_ERROR_FAILED_TO_PARSE_REQUEST,
			}
		}
	}
	const parsedRequest = maybeParsedRequest.value
	switch (parsedRequest.method) {
		case 'eth_getBlockByHash': return await getBlockByHash(ethereumClientService, simulationState, parsedRequest)
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
		case 'eth_signTypedData_v4': return await personalSign(simulator, websiteTabConnections, parsedRequest, request, settings.simulationMode, website, activeAddress)
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
		case 'web3_clientVersion': return await web3ClientVersion(ethereumClientService)
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
			await updateSimulationState(ethereumClientService, async () => {
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

export async function gateKeepRequestBehindAccessDialog(simulator: Simulator, websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, request: InterceptedRequest, website: Website, currentActiveAddress: bigint | undefined, settings: Settings) {
	const activeAddress = currentActiveAddress !== undefined ? getActiveAddressEntry(currentActiveAddress, settings.userAddressBook.activeAddresses) : undefined
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
		case 'popup_confirmDialog': return await confirmDialog(simulator, websiteTabConnections, parsedRequest)
		case 'popup_changeActiveAddress': return await changeActiveAddress(simulator, websiteTabConnections, parsedRequest)
		case 'popup_changeMakeMeRich': return await changeMakeMeRich(simulator, simulator.ethereum, parsedRequest, settings)
		case 'popup_changePage': return await changePage(parsedRequest)
		case 'popup_requestAccountsFromSigner': return await requestAccountsFromSigner(websiteTabConnections, parsedRequest)
		case 'popup_resetSimulation': return await resetSimulation(simulator, simulator.ethereum, settings)
		case 'popup_removeTransaction': return await removeTransaction(simulator, simulator.ethereum, parsedRequest, settings)
		case 'popup_removeSignedMessage': return await removeSignedMessage(simulator, simulator.ethereum, parsedRequest, settings)
		case 'popup_refreshSimulation': return await refreshSimulation(simulator, simulator.ethereum, settings)
		case 'popup_refreshConfirmTransactionDialogSimulation': return await refreshPopupConfirmTransactionSimulation(simulator, simulator.ethereum)
		case 'popup_refreshConfirmTransactionMetadata': return refreshPopupConfirmTransactionMetadata(simulator.ethereum, settings.userAddressBook, parsedRequest)
		case 'popup_personalSignApproval': return await confirmPersonalSign(simulator, websiteTabConnections, parsedRequest)
		case 'popup_interceptorAccess': return await confirmRequestAccess(simulator, websiteTabConnections, parsedRequest)
		case 'popup_changeInterceptorAccess': return await changeInterceptorAccess(simulator, websiteTabConnections, parsedRequest)
		case 'popup_changeActiveRpc': return await popupChangeActiveRpc(simulator, websiteTabConnections, parsedRequest, settings)
		case 'popup_changeChainDialog': return await changeChainDialog(simulator, websiteTabConnections, parsedRequest)
		case 'popup_enableSimulationMode': return await enableSimulationMode(simulator, websiteTabConnections, parsedRequest)
		case 'popup_addOrModifyAddressBookEntry': return await addOrModifyAddressBookEntry(simulator, websiteTabConnections, parsedRequest)
		case 'popup_getAddressBookData': return await getAddressBookData(parsedRequest, settings.userAddressBook)
		case 'popup_removeAddressBookEntry': return await removeAddressBookEntry(simulator, websiteTabConnections, parsedRequest)
		case 'popup_openAddressBook': return await openAddressBook()
		case 'popup_personalSignReadyAndListening': return await updatePendingPersonalSignViewWithPendingRequests(simulator.ethereum)
		case 'popup_changeChainReadyAndListening': return await updateChainChangeViewWithPendingRequest()
		case 'popup_interceptorAccessReadyAndListening': return await updateInterceptorAccessViewWithPendingRequests()
		case 'popup_confirmTransactionReadyAndListening': return await updateConfirmTransactionViewWithPendingTransaction()
		case 'popup_requestNewHomeData': return await homeOpened(simulator, true)
		case 'popup_homeOpened': return await homeOpened(simulator, false)
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
		case 'popup_simulateGovernanceContractExecution': return await simulateGovernanceContractExecutionOnPass(simulator.ethereum, settings.userAddressBook)
		case 'popup_fetchAbiAndNameFromEtherScan': return await fetchAbiAndNameFromEtherScan(parsedRequest)
		default: assertUnreachable(parsedRequest)
	}
}
