import { Simulator } from '../simulation/simulator.js'
import { bytes32String } from '../utils/bigint.js'
import { ERROR_INTERCEPTOR_UNKNOWN_ORIGIN } from '../utils/constants.js'
import { EstimateGasParams, EthBalanceParams, EthBlockByNumberParams, EthCallParams, EthereumAddress, EthereumData, EthereumQuantity, EthereumSignedTransactionWithBlockData, EthSubscribeParams, EthTransactionReceiptResponse, EthUnSubscribeParams, GetBlockReturn, GetCode, GetSimulationStack, GetSimulationStackReply, GetTransactionCount, JsonRpcNewHeadsNotification, NewHeadsSubscriptionData, PersonalSignParams, SendTransactionParams, SignTypedDataParams, SwitchEthereumChainParams, TransactionByHashParams, TransactionReceiptParams } from '../utils/wire-types.js'
import { postMessageIfStillConnected } from './background.js'
import { WebsiteAccessArray } from './settings.js'
import { openChangeChainDialog } from './windows/changeChain.js'
import { openConfirmTransactionDialog } from './windows/confirmTransaction.js'
import { openPersonalSignDialog } from './windows/personalSign.js'

const defaultCallAddress = 0x1n

export async function getBlockByNumber(simulator: Simulator, request: EthBlockByNumberParams) {
	const block = await simulator.simulationModeNode.getBlock(request.params[0], request.params[1])
	return { result: GetBlockReturn.serialize(block) }
}
export async function getBalance(simulator: Simulator, request: EthBalanceParams) {
	return { result: EthereumQuantity.serialize(await simulator.simulationModeNode.getBalance(request.params[0])) }
}
export async function getTransactionByHash(simulator: Simulator, request: TransactionByHashParams) {
	const result = await simulator.simulationModeNode.getTransactionByHash(request.params[0])
	if (result === undefined) return { result: undefined }
	return { result: EthereumSignedTransactionWithBlockData.serialize(result) }
}
export async function getTransactionReceipt(simulator: Simulator, request: TransactionReceiptParams) {
	return { result: EthTransactionReceiptResponse.serialize(await simulator.simulationModeNode.getTransactionReceipt(request.params[0])) }
}
export async function sendTransaction(simulator: Simulator, request: SendTransactionParams, port: browser.runtime.Port, requestId: number | undefined, simulationMode: boolean = true) {
	async function formTransaction() {
		const block = simulator.ethereum.getBlock()
		const chainId = simulator.ethereum.getChainId()
		const transactionCount = simulator.simulationModeNode.getTransactionCount(request.params[0].from)

		const maxFeePerGas = (await block).baseFeePerGas * 2n
		return {
			type: '1559' as const,
			from: request.params[0].from,
			chainId: await chainId,
			nonce: await transactionCount,
			maxFeePerGas: request.params[0].maxFeePerGas ? request.params[0].maxFeePerGas : maxFeePerGas,
			maxPriorityFeePerGas: request.params[0].maxPriorityFeePerGas ? request.params[0].maxPriorityFeePerGas : 1n,
			gas: request.params[0].gas ? request.params[0].gas : 90000n,
			to: request.params[0].to ? request.params[0].to : 0n,
			value: request.params[0].value ? request.params[0].value : 0n,
			input: request.params[0].data,
			accessList: []
		}
	}
	const origin = port.sender?.url
	if (origin === undefined) return ERROR_INTERCEPTOR_UNKNOWN_ORIGIN
	if (requestId === undefined) throw new Error('sendTransaction requires known requestId')
	return await openConfirmTransactionDialog(requestId, origin, simulationMode, formTransaction)
}

export async function call(simulator: Simulator, request: EthCallParams) {
	const transaction = {
		type: '1559' as const,
		from: defaultCallAddress,
		chainId: await simulator.ethereum.getChainId(),
		nonce: await simulator.simulationModeNode.getTransactionCount(defaultCallAddress),
		maxFeePerGas: 0n,
		maxPriorityFeePerGas: 0n,
		gas: await simulator.simulationModeNode.estimateGas({
			from: defaultCallAddress,
			to: request.params[0].to,
			data: request.params[0].data
		}),
		to: request.params[0].to,
		value: 0n,
		input: 'data' in request.params[0] || request.params[0].data === undefined ? new Uint8Array() : request.params[0].data,
		accessList: [],
	}
	const result = request.params.length > 1 ? await simulator.simulationModeNode.call(transaction, request.params[1]) : await simulator.simulationModeNode.call(transaction)
	return { result: result }
}
export async function blockNumber(simulator: Simulator) {
	const block = await simulator.simulationModeNode.getBlockNumber()
	return { result: bytes32String(block) }
}

export async function estimateGas(simulator: Simulator, request: EstimateGasParams) {
	return { result: EthereumQuantity.serialize(await simulator.simulationModeNode.estimateGas(request.params[0])) }
}

export async function subscribe(simulator: Simulator, port: browser.runtime.Port, request: EthSubscribeParams) {
	const result = await simulator.simulationModeNode.createSubscription(request, (subscriptionId: string, reply: JsonRpcNewHeadsNotification) => {
		return postMessageIfStillConnected(port, {
			interceptorApproved: true,
			options: request,
			result: NewHeadsSubscriptionData.serialize(reply.params),
			subscription: subscriptionId
		})
	})

	if (result === undefined) throw ('failed to create subscription')

	return { result: result }
}

export async function unsubscribe(simulator: Simulator, request: EthUnSubscribeParams) {
	return { result: simulator.simulationModeNode.remoteSubscription(request.params[0]) }
}

export async function getAccounts(getActiveAddressForDomain: (websiteAccess: WebsiteAccessArray, origin: string) => bigint | undefined, _simulator: Simulator, port: browser.runtime.Port) {
	const connection = window.interceptor.websitePortApprovals.get(port)
	if (connection === undefined || window.interceptor.settings === undefined) {
		return { result: [] }
	}
	const account = getActiveAddressForDomain(window.interceptor.settings.websiteAccess, connection.origin)
	if (account === undefined) {
		return {result: [] }
	}

	return { result: [EthereumAddress.serialize(account)] }
}

export async function chainId(simulator: Simulator) {
	return { result: EthereumQuantity.serialize(await simulator.ethereum.getChainId()) }
}

export async function gasPrice(simulator: Simulator) {
	return { result: EthereumQuantity.serialize(await simulator.ethereum.getGasPrice()) }
}

export async function personalSign(_simulator: Simulator, request: PersonalSignParams, requestId: number | undefined, simulationMode: boolean) {
	if (requestId === undefined) throw new Error('personalSign requires known requestId')
	return await openPersonalSignDialog(requestId, simulationMode, request)
}

export async function signTypedData(_simulator: Simulator, request: SignTypedDataParams, requestId: number | undefined, simulationMode: boolean) {
	if (requestId === undefined) throw new Error('signTypedData requires known requestId')
	return await openPersonalSignDialog(requestId, simulationMode, request)
}

export async function switchEthereumChain(simulator: Simulator, request: SwitchEthereumChainParams, port: browser.runtime.Port, requestId: number | undefined, simulationMode: boolean) {
	if (await simulator.ethereum.getChainId() === request.params[0].chainId) {
		// we are already on the right chain
		return { result: null }
	}
	const origin = port.sender?.url
	if (origin === undefined) return ERROR_INTERCEPTOR_UNKNOWN_ORIGIN
	if (requestId === undefined) throw new Error('switchEthereumChain requires known requestId')

	const favicon = port.sender?.tab?.favIconUrl
	return await openChangeChainDialog(requestId, simulationMode, origin, favicon, request.params[0].chainId)
}

export async function getCode(simulator: Simulator, request: GetCode) {
	return { result: EthereumData.serialize(await simulator.simulationModeNode.getCode(request.params[0], request.params[1])) }
}

export async function requestPermissions(getActiveAddressForDomain: (websiteAccess: WebsiteAccessArray, origin: string) => bigint | undefined, simulator: Simulator, port: browser.runtime.Port) {
	return await getAccounts(getActiveAddressForDomain, simulator, port)
}

export async function getPermissions() {
	return { result: [ { "eth_accounts": {} } ] }
}

export async function getTransactionCount(simulator: Simulator, request: GetTransactionCount) {
	return { result: EthereumQuantity.serialize(await simulator.ethereum.getTransactionCount(request.params[0], request.params[1])) }
}

export async function getSimulationStack(simulator: Simulator, request: GetSimulationStack) {
	switch (request.params[0]) {
		case '1.0.0': return {
			result: {
				version: '1.0.0',
				payload: GetSimulationStackReply.serialize(simulator.simulationModeNode.getSimulationStack()),
			}
		}
	}
}
