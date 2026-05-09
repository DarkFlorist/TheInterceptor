import { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { createEthereumSubscription, createNewFilter, getEthFilterChanges, getEthFilterLogs, removeEthereumSubscription } from '../simulation/services/EthereumSubscriptionService.js'
import { getSimulatedBalanceFromInput, getSimulatedBlockByHashFromInput, getSimulatedBlockFromInput, getSimulatedBlockNumberFromInput, getSimulatedCodeFromInput, getSimulatedLogs, getSimulatedTransactionByHashFromInput, getSimulatedTransactionReceipt, simulatedCallFromInput, simulateEstimateGasFromInput, getInputFieldFromDataOrInput, getSimulatedFeeHistory, getSimulatedTransactionCountFromInput } from '../simulation/services/SimulationModeEthereumClientService.js'
import { DEFAULT_CALL_ADDRESS, ERROR_INTERCEPTOR_GET_CODE_FAILED } from '../utils/constants.js'
import { WebsiteTabConnections } from '../types/user-interface-types.js'
import { ResolvedExecutionSimulationState, ResolvedSimulationInput, ResolvedSimulationState } from '../types/visualizer-types.js'
import { openChangeChainDialog } from './windows/changeChain.js'
import { InterceptedRequest, WebsiteSocket } from '../utils/requests.js'
import { EstimateGasParams, EthBalanceParams, EthBlockByHashParams, EthBlockByNumberParams, EthCallParams, EthNewFilter, EthGetLogsParams, EthSubscribeParams, EthUnSubscribeParams, FeeHistory, GetCode, GetFilterChanges, GetSimulationStack, GetTransactionCount, SendRawTransactionParams, SendTransactionParams, SwitchEthereumChainParams, TransactionByHashParams, TransactionReceiptParams, UninstallFilter, GetFilterLogs, InterceptorError } from '../types/JsonRpc-types.js'
import { Website } from '../types/websiteAccessTypes.js'
import { SignMessageParams } from '../types/jsonRpc-signing-types.js'
import { METAMASK_ERROR_BLANKET_ERROR } from '../utils/constants.js'
import { openConfirmTransactionDialogForMessage, openConfirmTransactionDialogForTransaction } from './windows/confirmTransaction.js'
import { handleUnexpectedError } from '../utils/errors.js'
import { openFetchSimulationStackDialogOrGetCachedResult } from './windows/fetchSimulationStack.js'
import { POPUP_PERFORMANCE_MARKS, markPerformance } from '../utils/popupPerformance.js'
import { TokenPriceService } from '../simulation/services/priceEstimator.js'
import { ResetSimulationServices } from '../simulation/serviceLifecycle.js'

export async function getBlockByHash(ethereumClientService: EthereumClientService, simulationInput: ResolvedSimulationInput, request: EthBlockByHashParams) {
	return { type: 'result' as const, method: request.method, result: await getSimulatedBlockByHashFromInput(ethereumClientService, undefined, simulationInput, request.params[0], request.params[1]) }
}
export async function getBlockByNumber(ethereumClientService: EthereumClientService, simulationInput: ResolvedSimulationInput, request: EthBlockByNumberParams) {
	return { type: 'result' as const, method: request.method, result: await getSimulatedBlockFromInput(ethereumClientService, undefined, simulationInput, request.params[0], request.params[1]) }
}
export async function getBalance(ethereumClientService: EthereumClientService, simulationInput: ResolvedSimulationInput, request: EthBalanceParams) {
	return { type: 'result' as const, method: request.method, result: await getSimulatedBalanceFromInput(ethereumClientService, undefined, simulationInput, request.params[0], request.params[1]) }
}
export async function getTransactionByHash(ethereumClientService: EthereumClientService, simulationInput: ResolvedSimulationInput, request: TransactionByHashParams) {
	const result = await getSimulatedTransactionByHashFromInput(ethereumClientService, undefined, simulationInput, request.params[0])
	if (result === null) return { type: 'result' as const, method: request.method, result: null }
	return { type: 'result' as const, method: request.method, result: result }
}
export async function getTransactionReceipt(ethereumClientService: EthereumClientService, simulationState: ResolvedExecutionSimulationState, request: TransactionReceiptParams) {
	return { type: 'result' as const, method: request.method, result: await getSimulatedTransactionReceipt(ethereumClientService, undefined, simulationState, request.params[0]) }
}

export async function sendTransaction(
	ethereumClientService: EthereumClientService,
	tokenPriceService: TokenPriceService,
	activeAddress: bigint | undefined,
	transactionParams: SendTransactionParams | SendRawTransactionParams,
	request: InterceptedRequest,
	website: Website,
	websiteTabConnections: WebsiteTabConnections,
	simulationMode = true,
) {
	markPerformance(POPUP_PERFORMANCE_MARKS.backgroundTransactionRequestReceived)
	const action = await openConfirmTransactionDialogForTransaction(ethereumClientService, tokenPriceService, request, transactionParams, simulationMode, activeAddress, website, websiteTabConnections)
	if (action.type === 'doNotReply') return action
	return { method: transactionParams.method, ...action }
}

async function singleCallWithFromOverride(ethereumClientService: EthereumClientService, simulationInput: ResolvedSimulationInput, request: EthCallParams, from: bigint) {
	const callParams = request.params[0]
	const blockTag = request.params.length > 1 ? request.params[1] : 'latest' as const
	const gasPrice = callParams.gasPrice !== undefined ? callParams.gasPrice : 0n
	const value = callParams.value !== undefined ? callParams.value : 0n

	const callTransaction = {
		type: '1559' as const,
		from,
		chainId: ethereumClientService.getChainId(),
		maxFeePerGas: gasPrice,
		maxPriorityFeePerGas: 0n,
		to: callParams.to === undefined ? null : callParams.to,
		value,
		input: getInputFieldFromDataOrInput(callParams),
		accessList: [],
	}

	return await simulatedCallFromInput(ethereumClientService, undefined, simulationInput, callTransaction, blockTag)
}

export async function call(ethereumClientService: EthereumClientService, simulationInput: ResolvedSimulationInput, request: EthCallParams) {
	const callParams = request.params[0]
	const from = callParams.from !== undefined ? callParams.from : DEFAULT_CALL_ADDRESS
	const callResult = await singleCallWithFromOverride(ethereumClientService, simulationInput, request, from)
	return { type: 'result' as const, method: request.method, ...callResult }
}

export async function blockNumber(ethereumClientService: EthereumClientService, simulationInput: ResolvedSimulationInput) {
	return { type: 'result' as const, method: 'eth_blockNumber' as const, result: await getSimulatedBlockNumberFromInput(ethereumClientService, undefined, simulationInput) }
}

export async function estimateGas(ethereumClientService: EthereumClientService, simulationInput: ResolvedSimulationInput, request: EstimateGasParams){
	const estimatedGas = await simulateEstimateGasFromInput(ethereumClientService, undefined, simulationInput, request.params[0])
	if ('error' in estimatedGas) return { type: 'result' as const, method: request.method, ...estimatedGas }
	return { type: 'result' as const, method: request.method, result: estimatedGas.gas }
}

export async function subscribe(socket: WebsiteSocket, request: EthSubscribeParams) {
	return { type: 'result' as const, method: request.method, result: await createEthereumSubscription(request, socket) }
}

export async function unsubscribe(socket: WebsiteSocket, request: EthUnSubscribeParams) {
	return { type: 'result' as const, method: request.method, result: await removeEthereumSubscription(socket, request.params[0]) }
}

export async function getAccounts(activeAddress: bigint | undefined) {
	if (activeAddress === undefined) return { type: 'result' as const, method: 'eth_accounts' as const, result: [] }
	return { type: 'result' as const, method: 'eth_accounts' as const, result: [activeAddress] }
}

export async function chainId(ethereumClientService: EthereumClientService) {
	return { type: 'result' as const, method: 'eth_chainId' as const, result: ethereumClientService.getChainId() }
}

export async function netVersion(ethereumClientService: EthereumClientService) {
	return { type: 'result' as const, method: 'net_version' as const, result: (await chainId(ethereumClientService)).result }
}

export async function gasPrice(ethereumClientService: EthereumClientService) {
	return { type: 'result' as const, method: 'eth_gasPrice' as const, result: await ethereumClientService.getGasPrice(undefined) }
}

export async function personalSign(
	ethereumClientService: EthereumClientService,
	tokenPriceService: TokenPriceService,
	activeAddress: bigint | undefined,
	transactionParams: SignMessageParams,
	request: InterceptedRequest,
	website: Website,
	websiteTabConnections: WebsiteTabConnections,
	simulationMode = true,
) {
	const action = await openConfirmTransactionDialogForMessage(ethereumClientService, tokenPriceService, request, transactionParams, simulationMode, activeAddress, website, websiteTabConnections)
	if (action.type === 'doNotReply') return action
	return { method: transactionParams.method, ...action }
}

export async function switchEthereumChain(ethereumClientService: EthereumClientService, tokenPriceService: TokenPriceService, resetSimulationServices: ResetSimulationServices, websiteTabConnections: WebsiteTabConnections, params: SwitchEthereumChainParams, request: InterceptedRequest, simulationMode: boolean, website: Website) {
	if (ethereumClientService.getChainId() === params.params[0].chainId) {
		// we are already on the right chain
		return { type: 'result' as const, method: params.method, result: null }
	}
	const change = await openChangeChainDialog(ethereumClientService, tokenPriceService, resetSimulationServices, websiteTabConnections, request, simulationMode, website, params)
	return { type: 'result' as const, method: params.method, ...change }
}

export async function getCode(ethereumClientService: EthereumClientService, simulationInput: ResolvedSimulationInput, request: GetCode) {
	const code = await getSimulatedCodeFromInput(ethereumClientService, undefined, simulationInput, request.params[0], request.params[1])
	if (code.statusCode === 'failure') return { type: 'result' as const, method: request.method, ...ERROR_INTERCEPTOR_GET_CODE_FAILED }
	return { type: 'result' as const, method: request.method, result: code.getCodeReturn }
}

export async function getPermissions() {
	return { type: 'result' as const, method: 'wallet_getPermissions', params: [], result: [ { eth_accounts: {} } ] } as const
}

export async function getTransactionCount(ethereumClientService: EthereumClientService, simulationInput: ResolvedSimulationInput, request: GetTransactionCount) {
	return { type: 'result' as const, method: request.method, result: await getSimulatedTransactionCountFromInput(ethereumClientService, undefined, simulationInput, request.params[0], request.params[1]) }
}

export async function getLogs(ethereumClientService: EthereumClientService, simulationState: ResolvedExecutionSimulationState, request: EthGetLogsParams) {
	return { type: 'result' as const, method: request.method, result: await getSimulatedLogs(ethereumClientService, undefined, simulationState, request.params[0]) }
}

export async function web3ClientVersion(ethereumClientService: EthereumClientService) {
	return { type: 'result' as const, method: 'web3_clientVersion' as const, result: await ethereumClientService.web3ClientVersion(undefined) }
}

export async function feeHistory(ethereumClientService: EthereumClientService, request: FeeHistory) {
	return { type: 'result' as const, method: 'eth_feeHistory' as const, result: await getSimulatedFeeHistory(ethereumClientService, undefined, request) }
}

export async function installNewFilter(socket: WebsiteSocket, request: EthNewFilter, ethereumClientService: EthereumClientService, simulationInput: ResolvedSimulationInput) {
	return { type: 'result' as const, method: request.method, result: await createNewFilter(request, socket, ethereumClientService, undefined, simulationInput) }
}

export async function uninstallNewFilter(socket: WebsiteSocket, request: UninstallFilter) {
	return { type: 'result' as const, method: request.method, result: await removeEthereumSubscription(socket, request.params[0]) }
}

export async function getFilterChanges(request: GetFilterChanges, ethereumClientService: EthereumClientService, simulationState: ResolvedExecutionSimulationState) {
	const result = await getEthFilterChanges(request.params[0], ethereumClientService, undefined, simulationState)
	if (result === undefined) return { type: 'result' as const, method: request.method, error: { code: METAMASK_ERROR_BLANKET_ERROR, message: 'No filter found for identifier' } }

	return { type: 'result' as const, method: request.method, result }
}

export async function getFilterLogs(request: GetFilterLogs, ethereumClientService: EthereumClientService, simulationState: ResolvedExecutionSimulationState) {
	const result = await getEthFilterLogs(request.params[0], ethereumClientService, undefined, simulationState)
	if (result === undefined) return { type: 'result' as const, method: request.method, error: { code: METAMASK_ERROR_BLANKET_ERROR, message: 'No filter found for identifier' } }
	return { type: 'result' as const, method: request.method, result }
}

export async function handleIterceptorError(request: InterceptorError) {
	await handleUnexpectedError(request)
	return { type: 'doNotReply' as const }
}

export async function requestInterceptorSimulatorStack(simulationState: ResolvedSimulationState, websiteTabConnections: WebsiteTabConnections, params: GetSimulationStack, website: Website, request: InterceptedRequest, socket: WebsiteSocket) {
	const result = await openFetchSimulationStackDialogOrGetCachedResult(simulationState, websiteTabConnections, params, website, request, socket)
	if ('error' in result && result.error !== undefined) return { type: 'result' as const, method: params.method, error: result.error }
	return { type: 'result' as const, method: params.method, ...result }
}
