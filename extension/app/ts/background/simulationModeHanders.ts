import { Simulator } from '../simulation/simulator.js'
import { bytes32String } from '../utils/bigint.js'
import { InterceptedRequest } from '../utils/interceptor-messages.js'
import { EstimateGasParams, EthBalanceParams, EthBlockByNumberParams, EthCallParams, EthereumAddress, EthereumData, EthereumQuantity, EthereumSignedTransactionWithBlockData, EthSubscribeParams, EthTransactionReceiptResponse, EthUnSubscribeParams, GetBlockReturn, GetCode, JsonRpcNewHeadsNotification, NewHeadsSubscriptionData, PersonalSignParams, RequestPermissions, SendTransactionParams, SignTypedDataV4Params, SwitchEthereumChainParams, TransactionByHashParams, TransactionReceiptParams } from '../utils/wire-types.js'
import { WebsiteAccess } from './settings.js'
import { openChangeChainDialog } from './windows/changeChain.js'
import { openConfirmTransactionDialog } from './windows/confirmTransaction.js'
import { openPersonalSignDialog } from './windows/personalSign.js'

const defaultCallAddress = 0x1n

export async function getBlockByNumber(simulator: Simulator, port: browser.runtime.Port, request: InterceptedRequest) {
	const balanceParams = EthBlockByNumberParams.parse(request.options)
	const block = await simulator.simulationModeNode.getBlock(balanceParams.params[0], balanceParams.params[1])
	return port.postMessage({
		interceptorApproved: true,
		requestId: request.requestId,
		options: request.options,
		result: GetBlockReturn.serialize(block)
	})
}
export async function getBalance(simulator: Simulator, port: browser.runtime.Port, request: InterceptedRequest) {
	const balanceParams = EthBalanceParams.parse(request.options)
	return port.postMessage({
		interceptorApproved: true,
		requestId: request.requestId,
		options: request.options,
		result: EthereumQuantity.serialize(await simulator.simulationModeNode.getBalance(balanceParams.params[0]))
	})
}
export async function getTransactionByHash(simulator: Simulator, port: browser.runtime.Port, request: InterceptedRequest) {
	const hashParams = TransactionByHashParams.parse(request.options)
	const result = await simulator.simulationModeNode.getTransactionByHash(hashParams.params[0])
	if(result === undefined) {
		return port.postMessage({
			interceptorApproved: true,
			requestId: request.requestId,
			options: request.options,
			result: undefined
		})
	}
	return port.postMessage({
		interceptorApproved: true,
		requestId: request.requestId,
		options: request.options,
		result: EthereumSignedTransactionWithBlockData.serialize(result)
	})
}
export async function getTransactionReceipt(simulator: Simulator, port: browser.runtime.Port, request: InterceptedRequest) {
	const receiptRequest = TransactionReceiptParams.parse(request.options)
	return port.postMessage({
		interceptorApproved: true,
		requestId: request.requestId,
		options: request.options,
		result: EthTransactionReceiptResponse.serialize(await simulator.simulationModeNode.getTransactionReceipt(receiptRequest.params[0]))
	})
}
export async function sendTransaction(simulator: Simulator, port: browser.runtime.Port, request: InterceptedRequest, simulationMode: boolean = true) {
	const requestTransaction = SendTransactionParams.parse(request.options)

	async function formTransaction() {
		const block = simulator.ethereum.getBlock()
		const chainId = simulator.ethereum.getChainId()
		const transactionCount = simulator.simulationModeNode.getTransactionCount(requestTransaction.params[0].from)

		const maxFeePerGas = (await block).baseFeePerGas * 2n
		return {
			type: '1559' as const,
			from: requestTransaction.params[0].from,
			chainId: await chainId,
			nonce: await transactionCount,
			maxFeePerGas: requestTransaction.params[0].maxFeePerGas ? requestTransaction.params[0].maxFeePerGas : maxFeePerGas,
			maxPriorityFeePerGas: requestTransaction.params[0].maxPriorityFeePerGas ? requestTransaction.params[0].maxPriorityFeePerGas : 1n,
			gas: requestTransaction.params[0].gas ? requestTransaction.params[0].gas : 90000n,
			to: requestTransaction.params[0].to ? requestTransaction.params[0].to : 0n,
			value: requestTransaction.params[0].value ? requestTransaction.params[0].value : 0n,
			input: requestTransaction.params[0].data,
			accessList: []
		}
	}
	return openConfirmTransactionDialog(port, request, simulationMode, formTransaction )
}

export async function sendRawTransaction(simulator: Simulator, port: browser.runtime.Port, request: InterceptedRequest) {
	return sendTransaction(simulator, port, request, true)
}

export async function call(simulator: Simulator, port: browser.runtime.Port, request: InterceptedRequest) {
	const params = EthCallParams.parse(request.options)
	const transaction = {
		type: '1559' as const,
		from: defaultCallAddress,
		chainId: await simulator.ethereum.getChainId(),
		nonce: await simulator.simulationModeNode.getTransactionCount(defaultCallAddress),
		maxFeePerGas: 0n,
		maxPriorityFeePerGas: 0n,
		gas: await simulator.simulationModeNode.estimateGas({
			from: defaultCallAddress,
			to: params.params[0].to,
			data: params.params[0].data
		}),
		to: params.params[0].to,
		value: 0n,
		input: params.params[0].data,
		accessList: []
	}
	const result = params.params.length > 1 ? await simulator.simulationModeNode.call(transaction, params.params[1]) : await simulator.simulationModeNode.call(transaction)
	return port.postMessage({
		interceptorApproved: true,
		requestId: request.requestId,
		options: request.options,
		result: result
	})
}
export async function blockNumber(simulator: Simulator, port: browser.runtime.Port, request: InterceptedRequest) {
	const block = await simulator.simulationModeNode.getBlockNumber()
	return port.postMessage({
		interceptorApproved: true,
		requestId: request.requestId,
		options: request.options,
		result: bytes32String(block)
	})
}

export async function estimateGas(simulator: Simulator, port: browser.runtime.Port, request: InterceptedRequest) {
	const gasParams = EstimateGasParams.parse(request.options)
	return port.postMessage({
		interceptorApproved: true,
		requestId: request.requestId,
		options: request.options,
		result: EthereumQuantity.serialize(await simulator.simulationModeNode.estimateGas(gasParams.params[0]))
	})
}

export async function subscribe(simulator: Simulator, port: browser.runtime.Port, request: InterceptedRequest) {
	const params = EthSubscribeParams.parse(request.options)
	const result = await simulator.simulationModeNode.createSubscription(params, (subscriptionId: string, reply: JsonRpcNewHeadsNotification) => {
		return port.postMessage({
			interceptorApproved: true,
			requestId: -1,
			options: request.options,
			result: NewHeadsSubscriptionData.serialize(reply.params),
			subscription: subscriptionId
		})
	})

	if (result === undefined) throw ('failed to create subscription')

	return port.postMessage({
		interceptorApproved: true,
		requestId: request.requestId,
		options: request.options,
		result: result
	})
}

export async function unsubscribe(simulator: Simulator, port: browser.runtime.Port, request: InterceptedRequest) {
	const params = EthUnSubscribeParams.parse(request.options)
	return port.postMessage({
		interceptorApproved: true,
		requestId: request.requestId,
		options: request.options,
		result: simulator.simulationModeNode.remoteSubscription(params.params[0])
	})
}

export async function getAccounts(getActiveAddressForDomain: (websiteAccess: readonly WebsiteAccess[], origin: string) => bigint | undefined, _simulator: Simulator, port: browser.runtime.Port, request: InterceptedRequest) {
	const connection = window.interceptor.websitePortApprovals.get(port)
	if (connection === undefined || window.interceptor.settings === undefined) {
		return port.postMessage({
			interceptorApproved: true,
			requestId: request.requestId,
			options: request.options,
			result: []
		})
	}
	const account = getActiveAddressForDomain(window.interceptor.settings.websiteAccess, connection.origin)
	if (account === undefined) {
		return port.postMessage({
			interceptorApproved: true,
			requestId: request.requestId,
			options: request.options,
			result: []
		})
	}

	return port.postMessage({
		interceptorApproved: true,
		requestId: request.requestId,
		options: request.options,
		result: [EthereumAddress.serialize(account)]
	})
}

export async function chainId(simulator: Simulator, port: browser.runtime.Port, request: InterceptedRequest) {
	return port.postMessage({
		interceptorApproved: true,
		requestId: request.requestId,
		options: request.options,
		result: EthereumQuantity.serialize(await simulator.ethereum.getChainId())
	})
}

export async function gasPrice(simulator: Simulator, port: browser.runtime.Port, request: InterceptedRequest) {
	return port.postMessage({
		interceptorApproved: true,
		requestId: request.requestId,
		options: request.options,
		result: EthereumQuantity.serialize(await simulator.ethereum.getGasPrice())
	})
}

export async function personalSign(_simulator: Simulator, port: browser.runtime.Port, request: InterceptedRequest, simulationMode: boolean = true) {
	const params = PersonalSignParams.parse(request.options)
	return openPersonalSignDialog(port, request, simulationMode, params.params[0], params.params[1], 'personalSign')
}

export async function signTypedDataV4(_simulator: Simulator, port: browser.runtime.Port, request: InterceptedRequest, simulationMode: boolean = true) {
	const params = SignTypedDataV4Params.parse(request.options)
	return openPersonalSignDialog(port, request, simulationMode, params.params[1], params.params[0], 'v4')

}

export async function switchEthereumChain(_simulator: Simulator, port: browser.runtime.Port, request: InterceptedRequest) {
	const params = SwitchEthereumChainParams.parse(request.options)
	return openChangeChainDialog(port, request, params.params[0].chainId)
}

export async function getCode(simulator: Simulator, port: browser.runtime.Port, request: InterceptedRequest) {
	const params = GetCode.parse(request.options)

	return port.postMessage({
		interceptorApproved: true,
		requestId: request.requestId,
		options: request.options,
		result: EthereumData.serialize(await simulator.simulationModeNode.getCode(params.params[0], params.params[1]))
	})
}

export async function requestPermissions(getActiveAddressForDomain: (websiteAccess: readonly WebsiteAccess[], origin: string) => bigint | undefined, simulator: Simulator, port: browser.runtime.Port, request: InterceptedRequest) {
	RequestPermissions.parse(request.options)
	return await getAccounts(getActiveAddressForDomain, simulator, port, request)
}

export async function getPermissions(_simulator: Simulator, port: browser.runtime.Port, request: InterceptedRequest) {
	return port.postMessage({
		interceptorApproved: true,
		requestId: request.requestId,
		options: request.options,
		result: [ { "eth_accounts": {} } ]
	})
}
