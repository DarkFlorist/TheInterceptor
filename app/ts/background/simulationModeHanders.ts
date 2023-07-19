import { ethers } from 'ethers'
import { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { createEthereumSubscription, removeEthereumSubscription } from '../simulation/services/EthereumSubscriptionService.js'
import { simulationGasLeft, getSimulatedBalance, getSimulatedBlock, getSimulatedBlockNumber, getSimulatedCode, getSimulatedLogs, getSimulatedStack, getSimulatedTransactionByHash, getSimulatedTransactionCount, getSimulatedTransactionReceipt, simulatedCall, simulateEstimateGas, getInputFieldFromDataOrInput } from '../simulation/services/SimulationModeEthereumClientService.js'
import { dataStringWith0xStart, stringToUint8Array } from '../utils/bigint.js'
import { CANNOT_SIMULATE_OFF_LEGACY_BLOCK, ERROR_INTERCEPTOR_GAS_ESTIMATION_FAILED, ERROR_INTERCEPTOR_GET_CODE_FAILED, KNOWN_CONTRACT_CALLER_ADDRESSES } from '../utils/constants.js'
import { RPCReply } from '../utils/interceptor-messages.js'
import { Website, WebsiteSocket, WebsiteTabConnections } from '../utils/user-interface-types.js'
import { SimulationState } from '../utils/visualizer-types.js'
import { EstimateGasParams, EthBalanceParams, EthBlockByNumberParams, EthCallParams, EthereumAddress, EthGetLogsParams, EthSubscribeParams, EthUnSubscribeParams, GetCode, GetSimulationStack, GetTransactionCount, OldSignTypedDataParams, PersonalSignParams, SendRawTransaction, SendTransactionParams, SignTypedDataParams, SwitchEthereumChainParams, TransactionByHashParams, TransactionReceiptParams } from '../utils/wire-types.js'
import { getConnectionDetails } from './accessManagement.js'
import { getSimulationResults } from './storageVariables.js'
import { openChangeChainDialog } from './windows/changeChain.js'
import { openConfirmTransactionDialog } from './windows/confirmTransaction.js'
import { openPersonalSignDialog } from './windows/personalSign.js'
import { assertNever } from '../utils/typescript.js'
import { InterceptedRequest } from '../utils/requests.js'
import { Simulator } from '../simulation/simulator.js'

const defaultCallAddress = 0x1n

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

function getFromField(websiteTabConnections: WebsiteTabConnections, simulationMode: boolean, transactionFrom: bigint | undefined, activeAddress: bigint | undefined, socket: WebsiteSocket) {
	if (simulationMode && transactionFrom !== undefined) {
		return transactionFrom // use `from` field directly from the dapp if we are in simulation mode and its available
	} else {
		const connection = getConnectionDetails(websiteTabConnections, socket)
		if (connection === undefined) throw new Error('Not connected')
		if (activeAddress === undefined) throw new Error('Access to active address is denied')
		return activeAddress
	}
}

export async function sendTransaction(
	simulator: Simulator,
	websiteTabConnections: WebsiteTabConnections,
	activeAddress: bigint | undefined,
	ethereumClientService: EthereumClientService,
	sendTransactionParams: SendTransactionParams,
	request: InterceptedRequest,
	simulationMode: boolean = true,
	website: Website,
) {
	const formTransaction = async() => {
		const simulationState = simulationMode ? (await getSimulationResults()).simulationState : undefined
		const block = getSimulatedBlock(ethereumClientService, simulationState)
		const transactionDetails = sendTransactionParams.params[0]
		const from = getFromField(websiteTabConnections, simulationMode, transactionDetails.from, activeAddress, request.uniqueRequestIdentifier.requestSocket)
		const transactionCount = getSimulatedTransactionCount(ethereumClientService, simulationState, from)

		const parentBlock = await block
		if (parentBlock.baseFeePerGas === undefined) throw new Error(CANNOT_SIMULATE_OFF_LEGACY_BLOCK)
		const transactionWithoutGas = {
			type: '1559' as const,
			from,
			chainId: ethereumClientService.getChainId(),
			nonce: await transactionCount,
			maxFeePerGas: transactionDetails.maxFeePerGas !== undefined && transactionDetails.maxFeePerGas !== null ? transactionDetails.maxFeePerGas : parentBlock.baseFeePerGas * 2n,
			maxPriorityFeePerGas: transactionDetails.maxPriorityFeePerGas !== undefined && transactionDetails.maxPriorityFeePerGas !== null ? transactionDetails.maxPriorityFeePerGas : 10n**8n, // 0.1 nanoEth/gas
			to: transactionDetails.to === undefined ? null : transactionDetails.to,
			value: transactionDetails.value != undefined  ? transactionDetails.value : 0n,
			input: getInputFieldFromDataOrInput(transactionDetails),
			accessList: [],
		}
		if (transactionDetails.gas === undefined) {
			const estimateGas = await simulateEstimateGas(ethereumClientService, simulationState, transactionWithoutGas)
			if ('error' in estimateGas) return estimateGas
			return {
				transaction: { ...transactionWithoutGas, gas: estimateGas.gas },
				website: website,
				transactionCreated: new Date(),
				transactionSendingFormat: 'eth_sendTransaction' as const,
			}
		}
		return {
			transaction: { ...transactionWithoutGas, gas: transactionDetails.gas },
			website: website,
			transactionCreated: new Date(),
			transactionSendingFormat: 'eth_sendTransaction' as const,
		}
	}
	return {
		method: sendTransactionParams.method,
		...await openConfirmTransactionDialog(
			simulator,
			ethereumClientService,
			request,
			sendTransactionParams,
			simulationMode,
			formTransaction,
			activeAddress,
		)
	}
}

export async function sendRawTransaction(
	simulator: Simulator,
	ethereumClientService: EthereumClientService,
	sendRawTransactionParams: SendRawTransaction,
	request: InterceptedRequest,
	simulationMode: boolean,
	website: Website,
	activeAddress: bigint | undefined,
) {
	const formTransaction = async() => {	
		const ethersTransaction = ethers.Transaction.from(dataStringWith0xStart(sendRawTransactionParams.params[0]))
		const transactionDetails = {
			from: EthereumAddress.parse(ethersTransaction.from),
			input: stringToUint8Array(ethersTransaction.data),
			...ethersTransaction.gasLimit === null ? { gas: ethersTransaction.gasLimit } : {},
			value: ethersTransaction.value,
			...ethersTransaction.to === null ? {} : { to: EthereumAddress.parse(ethersTransaction.to) },
			...ethersTransaction.gasPrice === null ? {} : { gasPrice: ethersTransaction.gasPrice },
			...ethersTransaction.maxPriorityFeePerGas === null ? {} : { maxPriorityFeePerGas: ethersTransaction.maxPriorityFeePerGas },
			...ethersTransaction.maxFeePerGas === null ? {} : { maxFeePerGas: ethersTransaction.maxFeePerGas },
		}

		const simulationState = (await getSimulationResults()).simulationState
		if (simulationState === undefined) return undefined
		const block = getSimulatedBlock(ethereumClientService, simulationState)
		const parentBlock = await block
		if (parentBlock.baseFeePerGas === undefined) throw new Error(CANNOT_SIMULATE_OFF_LEGACY_BLOCK)
		const maxFeePerGas = parentBlock.baseFeePerGas * 2n
		const transaction = {
			type: '1559' as const,
			from: transactionDetails.from,
			chainId: ethereumClientService.getChainId(),
			nonce: BigInt(ethersTransaction.nonce),
			maxFeePerGas: transactionDetails.maxFeePerGas ? transactionDetails.maxFeePerGas : maxFeePerGas,
			maxPriorityFeePerGas: transactionDetails.maxPriorityFeePerGas ? transactionDetails.maxPriorityFeePerGas : 1n,
			to: transactionDetails.to === undefined ? null : transactionDetails.to,
			value: transactionDetails.value ? transactionDetails.value : 0n,
			input: transactionDetails.input,
			accessList: [],
			gas: ethersTransaction.gasLimit,
		}
		return {
			transaction,
			website: website,
			transactionCreated: new Date(),
			transactionSendingFormat: 'eth_sendRawTransaction' as const,
		}
	}
	return { method: sendRawTransactionParams.method,
		...await openConfirmTransactionDialog(
			simulator,
			ethereumClientService,
			request,
			sendRawTransactionParams,
			simulationMode,
			formTransaction,
			activeAddress,
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
		gasLimit: callParams.gas === undefined ? simulationGasLeft(simulationState, await ethereumClientService.getBlock()) : callParams.gas
	}

	return await simulatedCall(ethereumClientService, simulationState, callTransaction, blockTag)
}

export async function call(ethereumClientService: EthereumClientService, simulationState: SimulationState | undefined, request: EthCallParams) {
	const callParams = request.params[0]
	const from = callParams.from !== undefined && !KNOWN_CONTRACT_CALLER_ADDRESSES.includes(callParams.from) ? callParams.from : defaultCallAddress
	const callResult = await singleCallWithFromOverride(ethereumClientService, simulationState, request, from)

	if (callResult.error !== undefined && callResult.error.code === ERROR_INTERCEPTOR_GAS_ESTIMATION_FAILED ) return { method: request.method, ...callResult }

	// if we fail our call because we are calling from a contract, retry and change address to our default calling address
	// TODO: Remove this logic and KNOWN_CONTRACT_CALLER_ADDRESSES when multicall supports calling from contracts
	if (callResult.error !== undefined && 'data' in callResult.error && callResult.error?.data === 'sender has deployed code' && from !== defaultCallAddress) {
		const callerChangeResult = await singleCallWithFromOverride(ethereumClientService, simulationState, request, defaultCallAddress)
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

export async function gasPrice(ethereumClientService: EthereumClientService) {
	return { method: 'eth_gasPrice' as const, result: await ethereumClientService.getGasPrice() }
}

export async function personalSign(ethereumClientService: EthereumClientService, websiteTabConnections: WebsiteTabConnections, params: PersonalSignParams | SignTypedDataParams | OldSignTypedDataParams, request: InterceptedRequest, simulationMode: boolean, website: Website, activeAddress: bigint | undefined): Promise<RPCReply> {
	return await openPersonalSignDialog(ethereumClientService, websiteTabConnections, params, request, simulationMode, website, activeAddress)
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
