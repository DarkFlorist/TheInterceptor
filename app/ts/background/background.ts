import { InpageScriptRequest, PopupMessage, RPCReply, Settings } from '../types/interceptor-messages.js'
import 'webextension-polyfill'
import { Simulator, parseEvents, runProtectorsForTransaction } from '../simulation/simulator.js'
import { getSimulationResults, getTabState, setLatestUnexpectedError, updateSimulationResults, updateSimulationResultsWithCallBack } from './storageVariables.js'
import { changeSimulationMode, getSettings, getMakeMeRich, getWethForChainId } from './settings.js'
import { blockNumber, call, chainId, estimateGas, gasPrice, getAccounts, getBalance, getBlockByNumber, getCode, getLogs, getPermissions, getSimulationStack, getTransactionByHash, getTransactionCount, getTransactionReceipt, netVersion, personalSign, sendTransaction, subscribe, switchEthereumChain, unsubscribe, web3ClientVersion, getBlockByHash, feeHistory, installNewFilter, uninstallNewFilter, getFilterChanges, getFilterLogs, handleIterceptorError } from './simulationModeHanders.js'
import { changeActiveAddress, changeMakeMeRich, changePage, resetSimulation, confirmDialog, refreshSimulation, removeTransactionOrSignedMessage, requestAccountsFromSigner, refreshPopupConfirmTransactionSimulation, confirmRequestAccess, changeInterceptorAccess, changeChainDialog, popupChangeActiveRpc, enableSimulationMode, addOrModifyAddressBookEntry, getAddressBookData, removeAddressBookEntry, refreshHomeData, interceptorAccessChangeAddressOrRefresh, refreshPopupConfirmTransactionMetadata, changeSettings, importSettings, exportSettings, setNewRpcList, simulateGovernanceContractExecutionOnPass, openNewTab, settingsOpened, changeAddOrModifyAddressWindowState, popupFetchAbiAndNameFromEtherscan, openWebPage, disableInterceptor, requestNewHomeData } from './popupMessageHandlers.js'
import { CompleteVisualizedSimulation, EnrichedEthereumEvents, ProtectorResults, SimulationState, VisualizedSimulatorState, WebsiteCreatedEthereumUnsignedTransactionOrFailed } from '../types/visualizer-types.js'
import { WebsiteTabConnections } from '../types/user-interface-types.js'
import { askForSignerAccountsFromSignerIfNotAvailable, interceptorAccessMetadataRefresh, requestAccessFromUser, updateInterceptorAccessViewWithPendingRequests } from './windows/interceptorAccess.js'
import { FourByteExplanations, METAMASK_ERROR_FAILED_TO_PARSE_REQUEST, METAMASK_ERROR_NOT_AUTHORIZED, METAMASK_ERROR_NOT_CONNECTED_TO_CHAIN, ERROR_INTERCEPTOR_DISABLED, NEW_BLOCK_ABORT, ETHEREUM_LOGS_LOGGER_ADDRESS } from '../utils/constants.js'
import { sendActiveAccountChangeToApprovedWebsitePorts, sendMessageToApprovedWebsitePorts, updateWebsiteApprovalAccesses, verifyAccess } from './accessManagement.js'
import { getActiveAddressEntry, getAddressBookEntriesForVisualiser, identifyAddress, nameTokenIds, retrieveEnsLabelHashes, retrieveEnsNodeHashes } from './metadataUtils.js'
import { getActiveAddress, sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { assertNever, assertUnreachable, modifyObject } from '../utils/typescript.js'
import { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { appendTransaction, calculateGasPrice, copySimulationState, getEmptySimulationStateWithRichAddress, getNonceFixedSimulatedTransactions, getTokenBalancesAfter, getWebsiteCreatedEthereumUnsignedTransactions, mockSignTransaction, setSimulationTransactionsAndSignedMessages } from '../simulation/services/SimulationModeEthereumClientService.js'
import { Semaphore } from '../utils/semaphore.js'
import { JsonRpcResponseError, handleUnexpectedError, isFailedToFetchError, isNewBlockAbort } from '../utils/errors.js'
import { formSimulatedAndVisualizedTransaction } from '../components/formVisualizerResults.js'
import { updateConfirmTransactionView } from './windows/confirmTransaction.js'
import { updateChainChangeViewWithPendingRequest } from './windows/changeChain.js'
import { craftPersonalSignPopupMessage } from './windows/personalSign.js'
import { InterceptedRequest, UniqueRequestIdentifier, WebsiteSocket } from '../utils/requests.js'
import { replyToInterceptedRequest } from './messageSending.js'
import { EthGetStorageAtParams, EthereumJsonRpcRequest, SendRawTransactionParams, SendTransactionParams, SupportedEthereumJsonRpcRequestMethods, WalletAddEthereumChain } from '../types/JsonRpc-types.js'
import { AddressBookEntry } from '../types/addressBookTypes.js'
import { Website } from '../types/websiteAccessTypes.js'
import { ConfirmTransactionTransactionSingleVisualization, PendingTransaction } from '../types/accessRequest.js'
import { RpcNetwork } from '../types/rpc.js'
import { serialize } from '../types/wire-types.js'
import { get4Byte, get4ByteString } from '../utils/calldata.js'
import { simulateCompoundGovernanceExecution } from '../simulation/compoundGovernanceFaking.js'
import { Interface } from 'ethers'
import { CompoundGovernanceAbi } from '../utils/abi.js'
import { dataStringWith0xStart } from '../utils/bigint.js'
import { connectedToSigner, ethAccountsReply, signerChainChanged, signerReply, walletSwitchEthereumChainReply } from './providerMessageHandlers.js'
import { makeSureInterceptorIsNotSleeping } from './sleeping.js'
import { decodeEthereumError } from '../utils/errorDecoding.js'
import { estimateEthereumPricesForTokens } from '../simulation/priceEstimator.js'

async function updateMetadataForSimulation(simulationState: SimulationState, ethereum: EthereumClientService, requestAbortController: AbortController | undefined, eventsForEachTransaction: readonly EnrichedEthereumEvents[], protectorResults: readonly ProtectorResults[]) {
	const settingsPromise = getSettings()
	const settings = await settingsPromise
	const allEvents = eventsForEachTransaction.flat()
	const ensLabelHashesPromise = retrieveEnsLabelHashes(allEvents)
	const ensNameHashesPromise = retrieveEnsNodeHashes(ethereum, allEvents)
	const addressBookEntryPromises = getAddressBookEntriesForVisualiser(ethereum, requestAbortController, allEvents, simulationState)
	const namedTokenIdPromises = nameTokenIds(ethereum, allEvents)
	const addressBookEntries = await addressBookEntryPromises
	const namedTokenIds = await namedTokenIdPromises
	const simulatedAndVisualizedTransactions = formSimulatedAndVisualizedTransaction(simulationState, eventsForEachTransaction, protectorResults, addressBookEntries, namedTokenIds, { ensNameHashes: await ensNameHashesPromise, ensLabelHashes: await ensLabelHashesPromise })
	const VisualizedPersonalSignRequest = simulationState.signedMessages.map((signedMessage) => craftPersonalSignPopupMessage(ethereum, requestAbortController, signedMessage, settings.currentRpcNetwork))
	return {
		namedTokenIds,
		addressBookEntries: addressBookEntries,
		simulatedAndVisualizedTransactions,
		visualizedPersonalSignRequests: await Promise.all(VisualizedPersonalSignRequest),
	}
}

export const simulateGovernanceContractExecution = async (pendingTransaction: PendingTransaction, ethereum: EthereumClientService) => {
	const returnError = (text: string) => ({ success: false as const, error: { type: 'Other' as const, message: text } })
	try {
		// identifies compound governane call and performs simulation if the vote passes
		if (pendingTransaction.transactionOrMessageCreationStatus !== 'Simulated') return returnError('Still simulating the voting transaction')
		const pendingResults = pendingTransaction.simulationResults
		if (pendingResults.statusCode !== 'success') return returnError('Voting transaction failed')
		const fourByte = get4Byte(pendingTransaction.transactionToSimulate.transaction.input)
		const fourByteString = get4ByteString(pendingTransaction.transactionToSimulate.transaction.input)
		if (fourByte === undefined || fourByteString === undefined) return returnError('Could not identify the 4byte signature')
		const explanation = FourByteExplanations[fourByte]
		if ((explanation !== 'Cast Vote'
			&& explanation !== 'Submit Vote'
			&& explanation !== 'Cast Vote by Signature'
			&& explanation !== 'Cast Vote with Reason'
			&& explanation !== 'Cast Vote with Reason and Additional Info'
			&& explanation !== 'Cast Vote with Reason And Additional Info by Signature')
			|| pendingResults.data.simulatedAndVisualizedTransactions[0]?.events.length !== 1) return returnError('Could not identify the transaction as a vote')
		
		const governanceContractInterface = new Interface(CompoundGovernanceAbi)
		const voteFunction = governanceContractInterface.getFunction(fourByteString)
		if (voteFunction === null) return returnError('Could not find the voting function')
		if (pendingTransaction.transactionToSimulate.transaction.to === null) return returnError('The transaction creates a contract instead of casting a vote')
		const params = governanceContractInterface.decodeFunctionData(voteFunction, dataStringWith0xStart(pendingTransaction.transactionToSimulate.transaction.input))
		const addr = await identifyAddress(ethereum, undefined, pendingTransaction.transactionToSimulate.transaction.to)
		if (!('abi' in addr) || addr.abi === undefined) return { success: false as const, error: { type: 'MissingAbi' as const, message: 'ABi for the governance contract is missing', addressBookEntry: addr } }
		const contractExecutionResult = await simulateCompoundGovernanceExecution(ethereum, addr, params[0])
		if (contractExecutionResult === undefined) return returnError('Failed to simulate governance execution')
		const parentBlock = await ethereum.getBlock(undefined)
		if (parentBlock.baseFeePerGas === undefined) return returnError('cannot build simulation from legacy block')
		const signedExecutionTransaction = mockSignTransaction({ ...contractExecutionResult.executingTransaction, gas: contractExecutionResult.ethSimulateV1CallResult.gasUsed })
		const tokenBalancesAfter = await getTokenBalancesAfter(ethereum, undefined, [contractExecutionResult.ethSimulateV1CallResult], parentBlock.number, [signedExecutionTransaction], [], {})

		if (tokenBalancesAfter[0] === undefined) return returnError('Could not compute token balances')

		const governanceContractSimulationState: SimulationState =  {
			addressToMakeRich: undefined,
			simulatedTransactions: [{
				ethSimulateV1CallResult: contractExecutionResult.ethSimulateV1CallResult,
				signedTransaction: signedExecutionTransaction,
				realizedGasPrice: calculateGasPrice(signedExecutionTransaction, parentBlock.gasUsed, parentBlock.gasLimit, parentBlock.baseFeePerGas),
				tokenBalancesAfter: tokenBalancesAfter[0],
				website: pendingTransaction.transactionToSimulate.website,
				created: new Date(),
				originalRequestParameters: pendingTransaction.originalRequestParameters,
				transactionIdentifier: pendingTransaction.transactionIdentifier,
			}],
			blockNumber: parentBlock.number,
			blockTimestamp: parentBlock.timestamp,
			baseFeePerGas: parentBlock.baseFeePerGas,
			rpcNetwork: ethereum.getRpcEntry(),
			simulationConductedTimestamp: new Date(),
			signedMessages: [],
		}
		return { success: true as const, result: await visualizeSimulatorState(governanceContractSimulationState, ethereum, undefined) }
	} catch(error) {
		console.warn(error)
		if (error instanceof Error) return returnError(error.message)
		return returnError('Unknown error occured')
	}
}

async function visualizeSimulatorState(simulationState: SimulationState, ethereum: EthereumClientService, requestAbortController: AbortController | undefined): Promise<VisualizedSimulatorState> {
	const transactions = getWebsiteCreatedEthereumUnsignedTransactions(simulationState.simulatedTransactions)
	const eventsForEachTransactionPromise = Promise.all(simulationState.simulatedTransactions.map(async (simulatedTransaction) => simulatedTransaction.ethSimulateV1CallResult.status === 'failure' ? [] : await parseEvents(simulatedTransaction.ethSimulateV1CallResult.logs, ethereum, requestAbortController)))
	const protectorPromises = Promise.all(transactions.map(async (transaction) => await runProtectorsForTransaction(simulationState, transaction, ethereum, requestAbortController)))
	const protectors = await protectorPromises
	const eventsForEachTransaction = await eventsForEachTransactionPromise
	const updatedMetadataPromise = updateMetadataForSimulation(simulationState, ethereum, requestAbortController, eventsForEachTransaction, protectors)

	function onlyTokensAndTokensWithKnownDecimals(metadata: AddressBookEntry): metadata is AddressBookEntry & { type: 'ERC20', decimals: `0x${ string }` } {
		return metadata.type === 'ERC20' && metadata.decimals !== undefined && metadata.address !== ETHEREUM_LOGS_LOGGER_ADDRESS
	}
	const metadataRestructure = (metadata: AddressBookEntry & { type: 'ERC20', decimals: bigint }) => ({ address: metadata.address, decimals: metadata.decimals })
	const updatedMetadata = await updatedMetadataPromise
	const tokenPrices = await estimateEthereumPricesForTokens(ethereum, requestAbortController, getWethForChainId(ethereum.getRpcEntry().chainId), updatedMetadata.addressBookEntries.filter(onlyTokensAndTokensWithKnownDecimals).map(metadataRestructure))
	return { ...updatedMetadata, tokenPrices, eventsForEachTransaction, protectors, simulationState }
}

export const updateSimulationMetadata = async (ethereum: EthereumClientService, requestAbortController: AbortController | undefined) => {
	return await updateSimulationResultsWithCallBack(async (prevState) => {
		if (prevState?.simulationState === undefined) return prevState
		try {
			const metadata = await updateMetadataForSimulation(prevState.simulationState, ethereum, requestAbortController, prevState.eventsForEachTransaction, prevState.protectors)
			return { ...prevState, ...metadata }
		} catch (error) {
			if (error instanceof Error && isNewBlockAbort(error)) return prevState
			if (error instanceof Error && isFailedToFetchError(error)) return prevState
			handleUnexpectedError(error)
			return prevState
		}
	})
}

const updateSimulationStateSemaphore = new Semaphore(1)
let simulationAbortController = new AbortController()

export async function updateSimulationState(ethereum: EthereumClientService, getUpdatedSimulationState: (simulationState: SimulationState | undefined) => Promise<SimulationState | undefined>, activeAddress: bigint | undefined, invalidateOldState: boolean, onlyIfNotAlreadyUpdating = false) {
	if (onlyIfNotAlreadyUpdating && updateSimulationStateSemaphore.getPermits() === 0) return
	simulationAbortController.abort(new Error(NEW_BLOCK_ABORT))
	simulationAbortController = new AbortController()
	const thisSimulationsController = simulationAbortController
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
		const doneState = { simulationUpdatingState: 'done' as const, simulationResultState: 'done' as const, simulationId, activeAddress }
		const emptyDoneResults: CompleteVisualizedSimulation = {
			...doneState,
			addressBookEntries: [],
			tokenPrices: [],
			eventsForEachTransaction: [],
			protectors: [],
			namedTokenIds: [],
			simulationState: undefined,
			simulatedAndVisualizedTransactions: [],
			visualizedPersonalSignRequests: [],
		}
		try {
			const updatedSimulationState = await getUpdatedSimulationState(simulationResults.simulationState)
			if (updatedSimulationState !== undefined && ethereum.getChainId() === updatedSimulationState?.rpcNetwork.chainId) {
				await updateSimulationResults({ ...await visualizeSimulatorState(updatedSimulationState, ethereum, thisSimulationsController), ...doneState })
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
			// clear simulation, unexpected error occured
			await updateSimulationResults(modifyObject(emptyDoneResults, { simulationResultState: 'corrupted' as const }))
			handleUnexpectedError(error)
			return undefined
		}
	})
}

let confirmTransactionAbortController = new AbortController()

export async function refreshConfirmTransactionSimulation(
	simulator: Simulator,
	ethereumClientService: EthereumClientService,
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

	const getCopiedSimulationState = async (simulationMode: boolean) => {
		if (simulationMode === false) return undefined
		const simResults = await getSimulationResults()
		if (simResults.simulationState === undefined) return undefined
		return copySimulationState(simResults.simulationState)
	}
	confirmTransactionAbortController.abort(new Error(NEW_BLOCK_ABORT))
	confirmTransactionAbortController = new AbortController()
	const thisConfirmTransactionAbortController = confirmTransactionAbortController
	const simState = await getCopiedSimulationState(simulationMode)
	try {
		const simulationStateWithNewTransaction = await appendTransaction(ethereumClientService, undefined, simState, transactionToSimulate)
		const noncefixed = await getNonceFixedSimulatedTransactions(ethereumClientService, undefined, simulationStateWithNewTransaction.simulatedTransactions)
		if (noncefixed === 'NoNonceErrors') return { statusCode: 'success' as const, data: { ...info, ...await visualizeSimulatorState(simulationStateWithNewTransaction, simulator.ethereum, undefined) } }
		const noncefixedNotPrepended = getWebsiteCreatedEthereumUnsignedTransactions(noncefixed)
		const nonceFixedState = await setSimulationTransactionsAndSignedMessages(ethereumClientService, undefined, simulationStateWithNewTransaction, noncefixedNotPrepended, simulationStateWithNewTransaction.signedMessages)
		const lastNonceFixed = noncefixed[noncefixed.length - 1]
		if (lastNonceFixed === undefined) throw new Error('last nonce fixed was undefined')
		const visualizedSimulatorState = await visualizeSimulatorState(nonceFixedState, simulator.ethereum, thisConfirmTransactionAbortController)
		const availableAbis = visualizedSimulatorState.addressBookEntries.map((entry) => 'abi' in entry && entry.abi !== undefined ? new Interface(entry.abi) : undefined).filter((abiOrUndefined): abiOrUndefined is Interface => abiOrUndefined === undefined)
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
							nonce: lastNonceFixed.signedTransaction.nonce,
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
			const identified = await identifyAddress(ethereumClientService, undefined, params.to)
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
				blockNumber: simState?.blockNumber || 0n, 
				simulationConductedTimestamp: new Date()
			}
		} }
	}
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
		return { type: 'forwardToSigner' as const, ...request }
	}

	if (maybeParsedRequest.success === false) {
		// biome-ignore lint/suspicious/noConsoleLog: <Used for support debugging>
		console.log({ request })
		console.warn(maybeParsedRequest.fullError)
		const maybePartiallyParsedRequest = SupportedEthereumJsonRpcRequestMethods.safeParse(request)
		// the method is some method that we are not supporting, forward it to the wallet if signer is available
		if (maybePartiallyParsedRequest.success === false && forwardToSigner) return { type: 'forwardToSigner' as const, unknownMethod: true, ...request }
		return {
			type: 'result' as const,
			method: request.method,
			error: {
				message: `Failed to parse RPC request: ${ JSON.stringify(serialize(InterceptedRequest, request)) }`,
				data: maybeParsedRequest.fullError === undefined ? 'Failed to parse RPC request' : maybeParsedRequest.fullError.toString(),
				code: METAMASK_ERROR_FAILED_TO_PARSE_REQUEST,
			}
		}
	}
	const parsedRequest = maybeParsedRequest.value
	makeSureInterceptorIsNotSleeping(ethereumClientService)
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
		case 'eth_signTypedData_v4': return await personalSign(simulator, activeAddress, ethereumClientService, parsedRequest, request, website, websiteTabConnections, !forwardToSigner)
		case 'wallet_switchEthereumChain': return await switchEthereumChain(simulator, websiteTabConnections, ethereumClientService, parsedRequest, request, settings.simulationMode, website)
		case 'wallet_requestPermissions': return await getAccounts(activeAddress)
		case 'wallet_getPermissions': return await getPermissions()
		case 'eth_accounts': return await getAccounts(activeAddress)
		case 'eth_requestAccounts': return await getAccounts(activeAddress)
		case 'eth_gasPrice': return await gasPrice(ethereumClientService)
		case 'eth_getTransactionCount': return await getTransactionCount(ethereumClientService, simulationState, parsedRequest)
		case 'interceptor_getSimulationStack': return await getSimulationStack(simulationState, parsedRequest)
		case 'eth_simulateV1': return { type: 'result', method: parsedRequest.method, error: { code: 10000, message: 'Cannot call eth_simulateV1 directly' } }
		case 'wallet_addEthereumChain': {
			if (forwardToSigner) return getForwardingMessage(parsedRequest)
			return { type: 'result' as const, method: parsedRequest.method, error: { code: 10000, message: 'wallet_addEthereumChain not implemented' } }
		}
		case 'eth_getStorageAt': {
			if (forwardToSigner) return getForwardingMessage(parsedRequest)
			return { type: 'result' as const, method: parsedRequest.method, error: { code: 10000, message: 'eth_getStorageAt not implemented' } }
		}
		case 'eth_getLogs': return await getLogs(ethereumClientService, simulationState, parsedRequest)
		case 'eth_sign': return { type: 'result' as const,method: parsedRequest.method, error: { code: 10000, message: 'eth_sign is deprecated' } }
		case 'eth_sendRawTransaction':
		case 'eth_sendTransaction': {
			if (forwardToSigner && settings.currentRpcNetwork.httpsRpc === undefined) return getForwardingMessage(parsedRequest)
			return await sendTransaction(simulator, activeAddress, ethereumClientService, parsedRequest, request, website, websiteTabConnections, !forwardToSigner)
		}
		case 'web3_clientVersion': return await web3ClientVersion(ethereumClientService)
		case 'eth_feeHistory': return await feeHistory(ethereumClientService, parsedRequest)
		case 'eth_newFilter': return await installNewFilter(socket, parsedRequest, ethereumClientService, simulationState)
		case 'eth_uninstallFilter': return await uninstallNewFilter(socket, parsedRequest)
		case 'eth_getFilterChanges': return await getFilterChanges(parsedRequest, ethereumClientService, simulationState)
		case 'eth_getFilterLogs': return await getFilterLogs(parsedRequest, ethereumClientService, simulationState)
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

export async function resetSimulatorStateFromConfig(ethereumClientService: EthereumClientService) {
	const settings = await getSettings()
	await updateSimulationState(ethereumClientService, async (simulationState) => {
		return await getEmptySimulationStateWithRichAddress(ethereumClientService, await getMakeMeRich() ? settings.activeSimulationAddress : undefined, simulationState)
	}, settings.activeSimulationAddress, true)
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
	if (change.simulationMode) {
		await changeSimulationMode({ ...change, ...'activeAddress' in change ? { activeSimulationAddress: change.activeAddress } : {} })
	} else {
		await changeSimulationMode({ ...change, ...'activeAddress' in change ? { activeSigningAddress: change.activeAddress } : {} })
	}

	const updatedSettings = await getSettings()
	sendPopupMessageToOpenWindows({ method: 'popup_settingsUpdated', data: updatedSettings })
	updateWebsiteApprovalAccesses(simulator, websiteTabConnections, updatedSettings)
	sendPopupMessageToOpenWindows({ method: 'popup_accounts_update' })
	await sendActiveAccountChangeToApprovedWebsitePorts(websiteTabConnections, updatedSettings)

	await changeActiveAddressAndChainAndResetSimulationSemaphore.execute(async () => {
		if (change.rpcNetwork !== undefined) {
			if (change.rpcNetwork.httpsRpc !== undefined) simulator.reset(change.rpcNetwork)
			sendMessageToApprovedWebsitePorts(websiteTabConnections, { method: 'chainChanged' as const, result: change.rpcNetwork.chainId })
			sendPopupMessageToOpenWindows({ method: 'popup_chain_update' })
		}

		if (updatedSettings.simulationMode) await resetSimulatorStateFromConfig(simulator.ethereum)
		// inform website about this only after we have updated simulation, as they often query the balance right after
		sendActiveAccountChangeToApprovedWebsitePorts(websiteTabConnections, await getSettings())
	})
}

export async function changeActiveRpc(simulator: Simulator, websiteTabConnections: WebsiteTabConnections, rpcNetwork: RpcNetwork, simulationMode: boolean) {
	// allow switching RPC only if we are in simulation mode, or that chain id would not change
	if (simulationMode || rpcNetwork.chainId === (await getSettings()).currentRpcNetwork.chainId) return await changeActiveAddressAndChainAndResetSimulation(simulator, websiteTabConnections, {
		simulationMode: simulationMode,
		rpcNetwork: rpcNetwork
	})
	sendMessageToApprovedWebsitePorts(websiteTabConnections, { method: 'request_signer_to_wallet_switchEthereumChain', result: rpcNetwork.chainId })
	await sendPopupMessageToOpenWindows({ method: 'popup_settingsUpdated', data: await getSettings() })
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
		const resolved = await handleRPCRequest(simulator, simulationState, websiteTabConnections, simulator.ethereum, request.uniqueRequestIdentifier.requestSocket, website, request, settings, activeAddress)
		return replyToInterceptedRequest(websiteTabConnections, { ...request, ...resolved })
	} catch (error) {
		if (error instanceof Error && isFailedToFetchError(error)) {
			return replyToInterceptedRequest(websiteTabConnections, {
				type: 'result', 
				...request,
				...METAMASK_ERROR_NOT_CONNECTED_TO_CHAIN,
			})
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
			message: 'User refused access to the wallet'
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
		switch (parsedRequest.method) {
			case 'popup_confirmDialog': return await confirmDialog(simulator, websiteTabConnections, parsedRequest)
			case 'popup_changeActiveAddress': return await changeActiveAddress(simulator, websiteTabConnections, parsedRequest)
			case 'popup_changeMakeMeRich': return await changeMakeMeRich(simulator, simulator.ethereum, parsedRequest, settings)
			case 'popup_changePage': return await changePage(parsedRequest)
			case 'popup_requestAccountsFromSigner': return await requestAccountsFromSigner(websiteTabConnections, parsedRequest)
			case 'popup_resetSimulation': return await resetSimulation(simulator, settings)
			case 'popup_removeTransactionOrSignedMessage': return await removeTransactionOrSignedMessage(simulator, simulator.ethereum, parsedRequest, settings)
			case 'popup_refreshSimulation': return await refreshSimulation(simulator, settings, false)
			case 'popup_refreshConfirmTransactionDialogSimulation': return await refreshPopupConfirmTransactionSimulation(simulator, simulator.ethereum)
			case 'popup_refreshConfirmTransactionMetadata': return refreshPopupConfirmTransactionMetadata(simulator.ethereum, confirmTransactionAbortController, parsedRequest)
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
			case 'popup_confirmTransactionReadyAndListening': return await updateConfirmTransactionView(simulator.ethereum)
			case 'popup_requestNewHomeData': return await requestNewHomeData(simulator, simulationAbortController)
			case 'popup_refreshHomeData': return await refreshHomeData(simulator)
			case 'popup_settingsOpened': return await settingsOpened()
			case 'popup_refreshInterceptorAccessMetadata': return await interceptorAccessMetadataRefresh()
			case 'popup_interceptorAccessChangeAddress': return await interceptorAccessChangeAddressOrRefresh(websiteTabConnections, parsedRequest)
			case 'popup_interceptorAccessRefresh': return await interceptorAccessChangeAddressOrRefresh(websiteTabConnections, parsedRequest)
			case 'popup_ChangeSettings': return await changeSettings(simulator, parsedRequest, simulationAbortController)
			case 'popup_openSettings': return await openNewTab('settingsView')
			case 'popup_import_settings': return await importSettings(parsedRequest)
			case 'popup_get_export_settings': return await exportSettings()
			case 'popup_set_rpc_list': return await setNewRpcList(simulator, parsedRequest, settings)
			case 'popup_simulateGovernanceContractExecution': return await simulateGovernanceContractExecutionOnPass(simulator.ethereum, parsedRequest)
			case 'popup_changeAddOrModifyAddressWindowState': return await changeAddOrModifyAddressWindowState(simulator.ethereum, parsedRequest)
			case 'popup_fetchAbiAndNameFromEtherscan': return await popupFetchAbiAndNameFromEtherscan(parsedRequest)
			case 'popup_openWebPage': return await openWebPage(parsedRequest)
			case 'popup_setDisableInterceptor': return await disableInterceptor(simulator, websiteTabConnections, parsedRequest)
			case 'popup_clearUnexpectedError': return await setLatestUnexpectedError(undefined)
			default: assertUnreachable(parsedRequest)
		}
	} catch(error: unknown) {
		if (error instanceof Error && (isNewBlockAbort(error) || isFailedToFetchError(error))) return
		throw error
	}
}
