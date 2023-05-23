import { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { createEthereumSubscription, removeEthereumSubscription } from '../simulation/services/EthereumSubscriptionService.js'
import { getSimulatedBalance, getSimulatedBlock, getSimulatedBlockNumber, getSimulatedCode, getSimulatedLogs, getSimulatedStack, getSimulatedTransactionByHash, getSimulatedTransactionCount, getSimulatedTransactionReceipt, simulatedCall, simulateEstimateGas } from '../simulation/services/SimulationModeEthereumClientService.js'
import { Simulator } from '../simulation/simulator.js'
import { bytes32String } from '../utils/bigint.js'
import { CANNOT_SIMULATE_OFF_LEGACY_BLOCK, ERROR_INTERCEPTOR_GAS_ESTIMATION_FAILED, ERROR_INTERCEPTOR_GET_CODE_FAILED, KNOWN_CONTRACT_CALLER_ADDRESSES } from '../utils/constants.js'
import { InterceptedRequest, Settings, WebsiteAccessArray } from '../utils/interceptor-messages.js'
import { Website, WebsiteSocket, WebsiteTabConnections } from '../utils/user-interface-types.js'
import { SimulationState } from '../utils/visualizer-types.js'
import { EstimateGasParams, EthBalanceParams, EthBlockByNumberParams, EthCallParams, EthereumAddress, EthereumData, EthereumQuantity, EthereumSignedTransactionWithBlockData, EthGetLogsParams, EthGetLogsResponse, EthSubscribeParams, EthTransactionReceiptResponse, EthUnSubscribeParams, GetBlockReturn, GetCode, GetSimulationStack, GetSimulationStackReply, GetTransactionCount, OldSignTypedDataParams, PersonalSignParams, SendTransactionParams, SignTypedDataParams, SwitchEthereumChainParams, TransactionByHashParams, TransactionReceiptParams } from '../utils/wire-types.js'
import { getConnectionDetails } from './accessManagement.js'
import { getSimulationResults } from './settings.js'
import { openChangeChainDialog } from './windows/changeChain.js'
import { openConfirmTransactionDialog } from './windows/confirmTransaction.js'
import { openPersonalSignDialog } from './windows/personalSign.js'

const defaultCallAddress = 0x1n

export async function getBlockByNumber(ethereumClientService: EthereumClientService, simulationState: SimulationState, request: EthBlockByNumberParams) {
	return { result: GetBlockReturn.serialize(await getSimulatedBlock(ethereumClientService, simulationState, request.params[0], request.params[1])) }
}
export async function getBalance(ethereumClientService: EthereumClientService, simulationState: SimulationState, request: EthBalanceParams) {
	return { result: EthereumQuantity.serialize(await getSimulatedBalance(ethereumClientService, simulationState, request.params[0])) }
}
export async function getTransactionByHash(ethereumClientService: EthereumClientService, simulationState: SimulationState, request: TransactionByHashParams) {
	const result = await getSimulatedTransactionByHash(ethereumClientService, simulationState, request.params[0])
	if (result === undefined) return { result: undefined }
	return { result: EthereumSignedTransactionWithBlockData.serialize(result) }
}
export async function getTransactionReceipt(ethereumClientService: EthereumClientService, simulationState: SimulationState, request: TransactionReceiptParams) {
	return { result: EthTransactionReceiptResponse.serialize(await getSimulatedTransactionReceipt(ethereumClientService, simulationState, request.params[0])) }
}

function getFromField(websiteTabConnections: WebsiteTabConnections, simulationMode: boolean, request: SendTransactionParams, getActiveAddressForDomain: (websiteAccess: WebsiteAccessArray, websiteOrigin: string, settings: Settings) => bigint | undefined, socket: WebsiteSocket, settings: Settings) {
	if (simulationMode && 'from' in request.params[0] && request.params[0].from !== undefined) {
		return request.params[0].from // use `from` field directly from the dapp if we are in simulation mode and its available
	} else {
		const connection = getConnectionDetails(websiteTabConnections, socket)
		if (connection === undefined) throw new Error('Not connected')

		const from = getActiveAddressForDomain(settings.websiteAccess, connection.websiteOrigin, settings)
		if (from === undefined) throw new Error('Access to active address is denied')
		return from
	}
}

export async function sendTransaction(
	websiteTabConnections: WebsiteTabConnections,
	getActiveAddressForDomain: (websiteAccess: WebsiteAccessArray, websiteOrigin: string, settings: Settings) => bigint | undefined,
	ethereumClientService: EthereumClientService,
	sendTransactionParams: SendTransactionParams,
	socket: WebsiteSocket,
	request: InterceptedRequest,
	simulationMode: boolean = true,
	website: Website,
	settings: Settings,
) {
	const formTransaction = async() => {
		const simulationState = (await getSimulationResults()).simulationState
		if (simulationState === undefined) return undefined
		const block = getSimulatedBlock(ethereumClientService, simulationState)
		const from = getFromField(websiteTabConnections, simulationMode, sendTransactionParams, getActiveAddressForDomain, socket, settings)
		const transactionCount = getSimulatedTransactionCount(ethereumClientService, simulationState, from)

		const parentBlock = await block
		if (parentBlock.baseFeePerGas === undefined) throw new Error(CANNOT_SIMULATE_OFF_LEGACY_BLOCK)
		const transactionDetails = sendTransactionParams.params[0]
		const transactionWithoutGas = {
			type: '1559' as const,
			from: from,
			chainId: ethereumClientService.getChainId(),
			nonce: await transactionCount,
			maxFeePerGas: transactionDetails.maxFeePerGas ? transactionDetails.maxFeePerGas : parentBlock.baseFeePerGas * 2n,
			maxPriorityFeePerGas: transactionDetails.maxPriorityFeePerGas ? transactionDetails.maxPriorityFeePerGas : 10n**8n, // 0.1 nanoEth/gas
			to: transactionDetails.to === undefined ? null : transactionDetails.to,
			value: transactionDetails.value ? transactionDetails.value : 0n,
			input: 'data' in transactionDetails && transactionDetails.data !== undefined ? transactionDetails.data : new Uint8Array(),
			accessList: [],
		}
		if (transactionDetails.gas === undefined) {
			const estimateGas = await simulateEstimateGas(ethereumClientService, simulationState, transactionWithoutGas)
			if ('error' in estimateGas) return estimateGas
			return {
				transaction: { ...transactionWithoutGas, gas: estimateGas.gas },
				website: website,
				transactionCreated: new Date(),
			}
		}
		return {
			transaction: { ...transactionWithoutGas, gas: transactionDetails.gas },
			website: website,
			transactionCreated: new Date(),
		}
	}
	return await openConfirmTransactionDialog(
		ethereumClientService,
		socket,
		request,
		website,
		simulationMode,
		formTransaction,
		settings,
	)
}

async function singleCallWithFromOverride(ethereumClientService: EthereumClientService, simulationState: SimulationState, request: EthCallParams, from: bigint) {
	const callParams = request.params[0]
	const blockTag = request.params.length > 1 ? request.params[1] : 'latest' as const
	const input = callParams.data !== undefined ? callParams.data : new Uint8Array()
	const gasPrice = callParams.gasPrice !== undefined ? callParams.gasPrice : 0n
	const value = callParams.value !== undefined ? callParams.value : 0n

	const transactionWithoutGas = {
		type: '1559' as const,
		from,
		chainId: ethereumClientService.getChainId(),
		nonce: await getSimulatedTransactionCount(ethereumClientService, simulationState, from),
		maxFeePerGas: gasPrice,
		maxPriorityFeePerGas: 0n,
		to: callParams.to === undefined ? null : callParams.to,
		value,
		input,
		accessList: [],
	}
	if (callParams.gas !== undefined) {
		return await simulatedCall(ethereumClientService, simulationState, { ...transactionWithoutGas, gasLimit: callParams.gas }, blockTag)
	}
	const estimatedGas = await simulateEstimateGas(ethereumClientService, simulationState, transactionWithoutGas)
	if ('error' in estimatedGas) return estimatedGas
	return await simulatedCall(ethereumClientService, simulationState, { ...transactionWithoutGas, gasLimit: estimatedGas.gas }, blockTag)
}

export async function call(ethereumClientService: EthereumClientService, simulationState: SimulationState, request: EthCallParams) {
	const callParams = request.params[0]
	const from = callParams.from !== undefined && !KNOWN_CONTRACT_CALLER_ADDRESSES.includes(callParams.from) ? callParams.from : defaultCallAddress
	const callResult = await singleCallWithFromOverride(ethereumClientService, simulationState, request, from)

	if (callResult.error !== undefined && callResult.error.code === ERROR_INTERCEPTOR_GAS_ESTIMATION_FAILED ) {
		return callResult
	}

	// if we fail our call because we are calling from a contract, retry and change address to our default calling address
	// TODO: Remove this logic and KNOWN_CONTRACT_CALLER_ADDRESSES when multicall supports calling from contracts
	if (callResult.error !== undefined && 'data' in callResult.error && callResult.error?.data === 'sender has deployed code' && from !== defaultCallAddress) {
		return await singleCallWithFromOverride(ethereumClientService, simulationState, request, defaultCallAddress)
	}
	return callResult
}

export async function blockNumber(ethereumClientService: EthereumClientService, simulationState: SimulationState, ) {
	const block = await getSimulatedBlockNumber(ethereumClientService, simulationState)
	return { result: bytes32String(block) }
}

export async function estimateGas(ethereumClientService: EthereumClientService, simulationState: SimulationState, request: EstimateGasParams) {
	const estimatedGas = await simulateEstimateGas(ethereumClientService, simulationState, request.params[0])
	if ('error' in estimatedGas) return estimatedGas
	return { result: EthereumQuantity.serialize(estimatedGas.gas) }
}

export async function subscribe(socket: WebsiteSocket, request: EthSubscribeParams) {
	return { result: await createEthereumSubscription(request, socket) }
}

export async function unsubscribe(socket: WebsiteSocket, request: EthUnSubscribeParams) {
	return { result: removeEthereumSubscription(socket, request.params[0]) }
}

export async function getAccounts(websiteTabConnections: WebsiteTabConnections, getActiveAddressForDomain: (websiteAccess: WebsiteAccessArray, websiteOrigin: string, settings: Settings) => bigint | undefined, socket: WebsiteSocket, settings: Settings) {
	const connection = getConnectionDetails(websiteTabConnections, socket)
	if (connection === undefined) {
		return { result: [] }
	}
	const account = getActiveAddressForDomain(settings.websiteAccess, connection.websiteOrigin, settings)
	if (account === undefined) {
		return { result: [] }
	}

	return { result: [EthereumAddress.serialize(account)] }
}

export async function chainId(simulator: Simulator) {
	return { result: EthereumQuantity.serialize(await simulator.ethereum.getChainId()) }
}

export async function gasPrice(simulator: Simulator) {
	return { result: EthereumQuantity.serialize(await simulator.ethereum.getGasPrice()) }
}

export async function personalSign(ethereumClientService: EthereumClientService, websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, params: PersonalSignParams | SignTypedDataParams | OldSignTypedDataParams, request: InterceptedRequest, simulationMode: boolean, website: Website, settings: Settings) {
	return await openPersonalSignDialog(ethereumClientService, websiteTabConnections, socket, params, request, simulationMode, website, settings)
}

export async function switchEthereumChain(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, ethereumClientService: EthereumClientService, params: SwitchEthereumChainParams, request: InterceptedRequest, simulationMode: boolean, website: Website) {
	if (ethereumClientService.getChainId() === params.params[0].chainId) {
		// we are already on the right chain
		return { result: null }
	}
	return await openChangeChainDialog(websiteTabConnections, socket, request, simulationMode, website, params.params[0].chainId)
}

export async function getCode(ethereumClientService: EthereumClientService, simulationState: SimulationState, request: GetCode) {
	const code = await getSimulatedCode(ethereumClientService, simulationState, request.params[0], request.params[1])
	if (code.statusCode === 'failure') return ERROR_INTERCEPTOR_GET_CODE_FAILED
	return { result: EthereumData.serialize(code.getCodeReturn) }
}

export async function requestPermissions(websiteTabConnections: WebsiteTabConnections, getActiveAddressForDomain: (websiteAccess: WebsiteAccessArray, websiteOrigin: string, settings: Settings) => bigint | undefined, socket: WebsiteSocket, settings: Settings) {
	return await getAccounts(websiteTabConnections, getActiveAddressForDomain, socket, settings)
}

export async function getPermissions() {
	return { result: [ { "eth_accounts": {} } ] }
}

export async function getTransactionCount(ethereumClientService: EthereumClientService, simulationState: SimulationState, request: GetTransactionCount) {
	return { result: EthereumQuantity.serialize(await getSimulatedTransactionCount(ethereumClientService, simulationState, request.params[0], request.params[1])) }
}

export async function getSimulationStack(simulationState: SimulationState, request: GetSimulationStack) {
	switch (request.params[0]) {
		case '1.0.0': return {
			result: {
				version: '1.0.0',
				payload: GetSimulationStackReply.serialize(getSimulatedStack(simulationState)),
			}
		}
	}
}

export async function getLogs(ethereumClientService: EthereumClientService, simulationState: SimulationState, request: EthGetLogsParams) {
	return { result: EthGetLogsResponse.serialize(await getSimulatedLogs(ethereumClientService, simulationState, request.params[0])) }
}
