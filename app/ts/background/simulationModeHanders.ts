import { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { createEthereumSubscription, removeEthereumSubscription } from '../simulation/services/EthereumSubscriptionService.js'
import { getSimulatedBalance, getSimulatedBlock, getSimulatedBlockNumber, getSimulatedCode, getSimulatedLogs, getSimulatedStack, getSimulatedTransactionByHash, getSimulatedTransactionCount, getSimulatedTransactionReceipt, simulatedCall, simulateEstimateGas, getInputFieldFromDataOrInput, getSimulatedBlockByHash, getSimulatedFeeHistory } from '../simulation/services/SimulationModeEthereumClientService.js'
import { DEFAULT_CALL_ADDRESS, ERROR_INTERCEPTOR_GAS_ESTIMATION_FAILED, ERROR_INTERCEPTOR_GET_CODE_FAILED, KNOWN_CONTRACT_CALLER_ADDRESSES } from '../utils/constants.js'
import { RPCReply } from '../types/interceptor-messages.js'
import { WebsiteTabConnections } from '../types/user-interface-types.js'
import { SimulationState } from '../types/visualizer-types.js'
import { openChangeChainDialog } from './windows/changeChain.js'
import { openConfirmTransactionDialog } from './windows/confirmTransaction.js'
import { openPersonalSignDialog } from './windows/personalSign.js'
import { assertNever } from '../utils/typescript.js'
import { InterceptedRequest, WebsiteSocket } from '../utils/requests.js'
import { EstimateGasParams, EthBalanceParams, EthBlockByHashParams, EthBlockByNumberParams, EthCallParams, EthGetLogsParams, EthSubscribeParams, EthUnSubscribeParams, FeeHistory, GetCode, GetSimulationStack, GetTransactionCount, SendRawTransactionParams, SendTransactionParams, SwitchEthereumChainParams, TransactionByHashParams, TransactionReceiptParams } from '../types/JsonRpc-types.js'
import { Simulator } from '../simulation/simulator.js'
import { Website } from '../types/websiteAccessTypes.js'
import { SignMessageParams } from '../types/jsonRpc-signing-types.js'

export async function getBlockByHash(ethereumClientService: EthereumClientService, simulationState: SimulationState | undefined, request: EthBlockByHashParams) {
	return { method: request.method, result: await getSimulatedBlockByHash(ethereumClientService, simulationState, request.params[0], request.params[1]) }
}
export async function getBlockByNumber(ethereumClientService: EthereumClientService, simulationState: SimulationState | undefined, request: EthBlockByNumberParams) {
	return { method: request.method, result: await getSimulatedBlock(ethereumClientService, simulationState, request.params[0], request.params[1]) }
}
export async function getBalance(ethereumClientService: EthereumClientService, simulationState: SimulationState | undefined, request: EthBalanceParams) {
	return { method: request.method, result: await getSimulatedBalance(ethereumClientService, simulationState, request.params[0]) }
}
export async function getTransactionByHash(ethereumClientService: EthereumClientService, simulationState: SimulationState | undefined, request: TransactionByHashParams) {
	const result = await getSimulatedTransactionByHash(ethereumClientService, simulationState, request.params[0])
	if (result === undefined) return { method: request.method, result: undefined }
	return { method: request.method, result: result }
}
export async function getTransactionReceipt(ethereumClientService: EthereumClientService, simulationState: SimulationState | undefined, request: TransactionReceiptParams) {
	return { method: request.method, result: await getSimulatedTransactionReceipt(ethereumClientService, simulationState, request.params[0]) }
}

export async function sendTransaction(
	simulator: Simulator,
	activeAddress: bigint | undefined,
	ethereumClientService: EthereumClientService,
	transactionParams: SendTransactionParams | SendRawTransactionParams,
	request: InterceptedRequest,
	simulationMode: boolean = true,
	website: Website,
) {
	return {
		method: transactionParams.method,
		...await openConfirmTransactionDialog(
			simulator,
			ethereumClientService,
			request,
			transactionParams,
			simulationMode,
			activeAddress,
			website,
		)
	}
}
async function singleCallWithFromOverride(ethereumClientService: EthereumClientService, simulationState: SimulationState | undefined, request: EthCallParams, from: bigint) {
	const callParams = request.params[0]
	const blockTag = request.params.length > 1 ? request.params[1] : 'latest' as const
	const gasPrice = callParams.gasPrice !== undefined ? callParams.gasPrice : 0n
	const value = callParams.value !== undefined ? callParams.value : 0n

	const callTransaction = {
		type: '1559' as const,
		from,
		chainId: ethereumClientService.getChainId(),
		nonce: await getSimulatedTransactionCount(ethereumClientService, simulationState, from),
		maxFeePerGas: gasPrice,
		maxPriorityFeePerGas: 0n,
		to: callParams.to === undefined ? null : callParams.to,
		value,
		input: getInputFieldFromDataOrInput(callParams),
		accessList: [],
	}

	return await simulatedCall(ethereumClientService, simulationState, callTransaction, blockTag)
}

export async function call(ethereumClientService: EthereumClientService, simulationState: SimulationState | undefined, request: EthCallParams) {
	const callParams = request.params[0]
	const from = callParams.from !== undefined && !KNOWN_CONTRACT_CALLER_ADDRESSES.includes(callParams.from) ? callParams.from : DEFAULT_CALL_ADDRESS
	const callResult = await singleCallWithFromOverride(ethereumClientService, simulationState, request, from)

	if (callResult.error !== undefined && callResult.error.code === ERROR_INTERCEPTOR_GAS_ESTIMATION_FAILED ) return { method: request.method, ...callResult }

	// if we fail our call because we are calling from a contract, retry and change address to our default calling address
	// TODO: Remove this logic and KNOWN_CONTRACT_CALLER_ADDRESSES when multicall supports calling from contracts
	if (callResult.error !== undefined && 'data' in callResult.error && callResult.error?.data === 'sender has deployed code' && from !== DEFAULT_CALL_ADDRESS) {
		const callerChangeResult = await singleCallWithFromOverride(ethereumClientService, simulationState, request, DEFAULT_CALL_ADDRESS)
		if (callerChangeResult.error !== undefined) return { method: request.method, ...callerChangeResult }
		return { method: request.method, ...callerChangeResult }
	}
	return { method: request.method, ...callResult }
}

export async function blockNumber(ethereumClientService: EthereumClientService, simulationState: SimulationState | undefined) {
	return { method: 'eth_blockNumber' as const, result: await getSimulatedBlockNumber(ethereumClientService, simulationState) }
}

export async function estimateGas(ethereumClientService: EthereumClientService, simulationState: SimulationState | undefined, request: EstimateGasParams){
	const estimatedGas = await simulateEstimateGas(ethereumClientService, simulationState, request.params[0])
	if ('error' in estimatedGas) return { method: request.method, ...estimatedGas }
	return { method: request.method, result: estimatedGas.gas }
}

export async function subscribe(socket: WebsiteSocket, request: EthSubscribeParams) {
	return { method: request.method, result: await createEthereumSubscription(request, socket) }
}

export async function unsubscribe(socket: WebsiteSocket, request: EthUnSubscribeParams) {
	return { method: request.method, result: await removeEthereumSubscription(socket, request.params[0]) }
}

export async function getAccounts(activeAddress: bigint | undefined) {
	if (activeAddress === undefined) return { method: 'eth_accounts' as const, result: [] }
	return { method: 'eth_accounts' as const, result: [activeAddress] }
}

export async function chainId(ethereumClientService: EthereumClientService) {
	return { method: 'eth_chainId' as const, result: ethereumClientService.getChainId() }
}

export async function netVersion(ethereumClientService: EthereumClientService) {
	return { method: 'net_version' as const, result: (await chainId(ethereumClientService)).result }
}

export async function gasPrice(ethereumClientService: EthereumClientService) {
	return { method: 'eth_gasPrice' as const, result: await ethereumClientService.getGasPrice() }
}

export async function personalSign(simulator: Simulator, websiteTabConnections: WebsiteTabConnections, params: SignMessageParams, request: InterceptedRequest, simulationMode: boolean, website: Website, activeAddress: bigint | undefined): Promise<RPCReply> {
	return await openPersonalSignDialog(simulator, websiteTabConnections, params, request, simulationMode, website, activeAddress)
}

export async function switchEthereumChain(simulator: Simulator, websiteTabConnections: WebsiteTabConnections, ethereumClientService: EthereumClientService, params: SwitchEthereumChainParams, request: InterceptedRequest, simulationMode: boolean, website: Website) {
	if (ethereumClientService.getChainId() === params.params[0].chainId) {
		// we are already on the right chain
		return { method: params.method, result: null }
	}
	const change = await openChangeChainDialog(simulator, websiteTabConnections, request, simulationMode, website, params)
	return { method: params.method, ...change }
}

export async function getCode(ethereumClientService: EthereumClientService, simulationState: SimulationState | undefined, request: GetCode) {
	const code = await getSimulatedCode(ethereumClientService, simulationState, request.params[0], request.params[1])
	if (code.statusCode === 'failure') return { method: request.method, ...ERROR_INTERCEPTOR_GET_CODE_FAILED }
	return { method: request.method, result: code.getCodeReturn }
}

export async function getPermissions() {
	return { method: 'wallet_getPermissions', params: [], result: [ { "eth_accounts": {} } ] } as const
}

export async function getTransactionCount(ethereumClientService: EthereumClientService, simulationState: SimulationState | undefined, request: GetTransactionCount) {
	return { method: request.method, result: await getSimulatedTransactionCount(ethereumClientService, simulationState, request.params[0], request.params[1]) }
}

export async function getSimulationStack(simulationState: SimulationState | undefined, request: GetSimulationStack) {
	switch (request.params[0]) {
		case '1.0.0': return {
			method: request.method,
			result: {
				version: '1.0.0',
				payload: simulationState === undefined ? [] : getSimulatedStack(simulationState),
			} as const
		}
		default: assertNever(request.params[0])
	}
}

export async function getLogs(ethereumClientService: EthereumClientService, simulationState: SimulationState | undefined, request: EthGetLogsParams) {
	return { method: request.method, result: await getSimulatedLogs(ethereumClientService, simulationState, request.params[0]) }
}

export async function web3ClientVersion(ethereumClientService: EthereumClientService) {
	return { method: 'web3_clientVersion' as const, result: await ethereumClientService.web3ClientVersion() }
}

export async function feeHistory(ethereumClientService: EthereumClientService, request: FeeHistory) {
	return { method: 'eth_feeHistory' as const, result: await getSimulatedFeeHistory(ethereumClientService, request) }
}
