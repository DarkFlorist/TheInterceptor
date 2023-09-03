import * as funtypes from 'funtypes'
import { EthereumAddress, EthereumBlockHeader, EthereumBlockHeaderWithTransactionHashes, EthereumBlockTag, EthereumBytes256, EthereumBytes32, EthereumData, EthereumInput, EthereumQuantity, EthereumUnsignedTransaction, LiteralConverterParserFactory, RevertErrorParser } from './wire-types.js'
import { areEqual } from '../utils/typed-arrays.js'
import { ExecutionSpec383MultiCallParams } from './multicall-types.js'

export type EthGetStorageAtResponse = funtypes.Static<typeof EthGetStorageAtResponse>
export const EthGetStorageAtResponse = funtypes.Union(
	EthereumBytes32,
	funtypes.String.withParser({ parse: x => x === '0x' ? { success: true, value: null } : { success: false, message: `eth_getStorageAt didn't return 32 bytes of data nor 0x.` } }),
)

export type EthGetLogsRequest = funtypes.Static<typeof EthGetLogsRequest>
export const EthGetLogsRequest = funtypes.Intersect(
	funtypes.Union(
		funtypes.ReadonlyObject({ blockHash: EthereumBytes32 }).asReadonly(),
		funtypes.Partial({ fromBlock: EthereumBlockTag, toBlock: EthereumBlockTag }).asReadonly(),
	),
	funtypes.Partial({
		address: funtypes.Union(EthereumAddress, funtypes.ReadonlyArray(EthereumAddress)),
		topics: funtypes.ReadonlyArray(funtypes.Union(EthereumBytes32, funtypes.ReadonlyArray(EthereumBytes32), funtypes.Null)),
	}).asReadonly()
)

export type EthGetLogsResponse = funtypes.Static<typeof EthGetLogsResponse>
export const EthGetLogsResponse = funtypes.ReadonlyArray(
	funtypes.ReadonlyObject({
		removed: funtypes.Boolean,
		logIndex: funtypes.Union(EthereumQuantity, funtypes.Null),
		transactionIndex: funtypes.Union(EthereumQuantity, funtypes.Null),
		transactionHash: funtypes.Union(EthereumBytes32, funtypes.Null),
		blockHash: funtypes.Union(EthereumBytes32, funtypes.Null),
		blockNumber: funtypes.Union(EthereumQuantity, funtypes.Null),
		address: EthereumAddress,
		data: EthereumInput,
		topics: funtypes.ReadonlyArray(EthereumBytes32),
	}).asReadonly()
)

export type MulticallRequestParameters = funtypes.Static<typeof MulticallRequestParameters>
export const MulticallRequestParameters = funtypes.ReadonlyTuple(
	EthereumQuantity, // block number
	EthereumAddress, // miner
	funtypes.ReadonlyArray(EthereumUnsignedTransaction),
)

export type MulticallResponseEventLog = funtypes.Static<typeof MulticallResponseEventLog>
export const MulticallResponseEventLog =  funtypes.ReadonlyObject({
	loggersAddress: EthereumAddress,
	data: EthereumInput,
	topics: funtypes.ReadonlyArray(EthereumBytes32),
}).asReadonly()

export type MulticallResponseEventLogs = funtypes.Static<typeof MulticallResponseEventLogs>
export const MulticallResponseEventLogs = funtypes.ReadonlyArray(MulticallResponseEventLog)

export type EthBalanceChanges = funtypes.Static<typeof EthBalanceChanges>
export const EthBalanceChanges = funtypes.ReadonlyArray(
	funtypes.ReadonlyObject({
		address: EthereumAddress,
		before: EthereumQuantity,
		after: EthereumQuantity,
	}).asReadonly()
)

export type SingleMulticallResponse = funtypes.Static<typeof SingleMulticallResponse>
export const SingleMulticallResponse = funtypes.Union(
	funtypes.ReadonlyObject({
		statusCode: funtypes.Literal(1).withParser(LiteralConverterParserFactory(1, 'success' as const)),
		gasSpent: EthereumQuantity,
		returnValue: EthereumData,
		events: MulticallResponseEventLogs,
		balanceChanges: EthBalanceChanges,
	}).asReadonly(),
	funtypes.ReadonlyObject({
		statusCode: funtypes.Literal(0).withParser(LiteralConverterParserFactory(0, 'failure' as const)),
		gasSpent: EthereumQuantity,
		error: funtypes.String.withParser(RevertErrorParser),
		returnValue: EthereumData,
	}).asReadonly(),
)

export type MulticallResponse = funtypes.Static<typeof MulticallResponse>
export const MulticallResponse = funtypes.ReadonlyArray(SingleMulticallResponse)

export type DappRequestTransaction = funtypes.Static<typeof DappRequestTransaction>
export const DappRequestTransaction = funtypes.ReadonlyPartial({
	from: EthereumAddress,
	gas: EthereumQuantity,
	value: EthereumQuantity,
	to: funtypes.Union(EthereumAddress, funtypes.Null),
	gasPrice: EthereumQuantity,
	maxPriorityFeePerGas: funtypes.Union(EthereumQuantity, funtypes.Null), // etherscan sets this field to null, remove this if etherscan fixes this
	maxFeePerGas: funtypes.Union(EthereumQuantity, funtypes.Null), // etherscan sets this field to null, remove this if etherscan fixes this
	data: EthereumData,
	input: EthereumData,
}).withConstraint((dappRequestTransaction) => {
	if (dappRequestTransaction.input !== undefined && dappRequestTransaction.data !== undefined) {
		if (typeof dappRequestTransaction.input === 'string') {
			// workaround for https://github.com/ForbesLindesay/funtypes/issues/62
			return dappRequestTransaction.input === dappRequestTransaction.data
		}
		return areEqual(dappRequestTransaction.input, dappRequestTransaction.data)
	}
	return true
})
.withConstraint((x) => {
	if (x.gasPrice !== undefined) {
		return x.maxPriorityFeePerGas === undefined && x.maxFeePerGas === undefined
	} else if (x.maxPriorityFeePerGas !== undefined) {
		return x.maxFeePerGas !== undefined && x.gasPrice === undefined
	} else if (x.maxFeePerGas !== undefined) {
		return x.maxPriorityFeePerGas !== undefined && x.gasPrice === undefined
	} else {
		return true
	}
})

export type EthTransactionReceiptResponse = funtypes.Static<typeof EthTransactionReceiptResponse>
export const EthTransactionReceiptResponse = funtypes.Union(
	funtypes.Null,
	funtypes.Intersect(
		funtypes.MutablePartial({
			author: EthereumAddress,
		}),
		funtypes.ReadonlyObject({
			type: funtypes.Union(
				funtypes.Union(funtypes.Literal('0x0').withParser(LiteralConverterParserFactory('0x0', 'legacy' as const)), funtypes.Literal(undefined).withParser(LiteralConverterParserFactory(undefined, 'legacy' as const))),
				funtypes.Literal('0x0').withParser(LiteralConverterParserFactory('0x0', 'legacy' as const)),
				funtypes.Literal('0x1').withParser(LiteralConverterParserFactory('0x1', '2930' as const)),
				funtypes.Literal('0x2').withParser(LiteralConverterParserFactory('0x2', '1559' as const)),
			),
			blockHash: EthereumBytes32,
			blockNumber: EthereumQuantity,
			transactionHash: EthereumBytes32,
			transactionIndex: EthereumQuantity,
			contractAddress: funtypes.Union(funtypes.Null, EthereumAddress),
			cumulativeGasUsed: EthereumQuantity,
			gasUsed: EthereumQuantity,
			effectiveGasPrice: EthereumQuantity,
			from: EthereumAddress,
			to: funtypes.Union(funtypes.Null, EthereumAddress),
			logs: EthGetLogsResponse,
			logsBloom: EthereumBytes256,
			status: funtypes.Union(
				funtypes.Literal('0x0').withParser(LiteralConverterParserFactory('0x0', 'failure' as const)),
				funtypes.Literal('0x1').withParser(LiteralConverterParserFactory('0x1', 'success' as const)),
			),
		}).asReadonly()
	)
)

export type GetBlockReturn = funtypes.Static<typeof GetBlockReturn>
export const GetBlockReturn = funtypes.Union(EthereumBlockHeader, EthereumBlockHeaderWithTransactionHashes)

export const NewHeadsSubscriptionData = funtypes.ReadonlyObject({
	subscription: funtypes.String,
	result: EthereumBlockHeaderWithTransactionHashes
}).asReadonly()

export type JsonRpcNewHeadsNotification = funtypes.Static<typeof JsonRpcNewHeadsNotification>
export const JsonRpcNewHeadsNotification = funtypes.ReadonlyObject({
	jsonrpc: funtypes.Literal('2.0'),
	method: funtypes.String,
	params: NewHeadsSubscriptionData
}).asReadonly()

export type JsonSubscriptionNotification = funtypes.Static<typeof JsonSubscriptionNotification>
export const JsonSubscriptionNotification = funtypes.ReadonlyObject({
	jsonrpc: funtypes.Literal('2.0'),
	method: funtypes.Literal('eth_subscription'),
	params: funtypes.ReadonlyObject({
		result: funtypes.Union(EthereumBlockHeader, EthereumBytes32),
		subscription: funtypes.String
	}).asReadonly()
}).asReadonly()

export type JsonRpcSuccessResponse = funtypes.Static<typeof JsonRpcSuccessResponse>
export const JsonRpcSuccessResponse = funtypes.ReadonlyObject({
	jsonrpc: funtypes.Literal('2.0'),
	id: funtypes.Union(funtypes.String, funtypes.Number),
	result: funtypes.Unknown,
}).asReadonly()

export type JsonRpcErrorResponse = funtypes.Static<typeof JsonRpcErrorResponse>
export const JsonRpcErrorResponse = funtypes.ReadonlyObject({
	jsonrpc: funtypes.Literal('2.0'),
	id: funtypes.Union(funtypes.String, funtypes.Number),
	error: funtypes.ReadonlyObject({
		code: funtypes.Number,
		message: funtypes.String,
		data: funtypes.Unknown,
	}).asReadonly(),
}).asReadonly()


export type JsonRpcNotification = funtypes.Static<typeof JsonRpcNotification>
export const JsonRpcNotification = funtypes.Union(JsonRpcNewHeadsNotification, JsonSubscriptionNotification)

export type JsonRpcRequest = funtypes.Static<typeof JsonRpcRequest>
export const JsonRpcRequest = funtypes.ReadonlyObject({
	jsonrpc: funtypes.Literal('2.0'),
	id: funtypes.Union(funtypes.String, funtypes.Number),
	method: funtypes.String,
	params: funtypes.Union(funtypes.ReadonlyArray(funtypes.Unknown), funtypes.Literal(undefined).withParser(LiteralConverterParserFactory(undefined, [])))
})

export type JsonRpcResponse = funtypes.Static<typeof JsonRpcResponse>
export const JsonRpcResponse = funtypes.Union(JsonRpcErrorResponse, JsonRpcSuccessResponse)

export type JsonRpcMessage = funtypes.Static<typeof JsonRpcMessage>
export const JsonRpcMessage = funtypes.Union(JsonRpcResponse, JsonRpcNotification, JsonRpcRequest)

export type TransactionByHashParams = funtypes.Static<typeof TransactionByHashParams>
export const TransactionByHashParams = funtypes.ReadonlyObject({
	method: funtypes.Literal('eth_getTransactionByHash'),
	params: funtypes.ReadonlyTuple(EthereumBytes32)
})

export type SendTransactionParams = funtypes.Static<typeof SendTransactionParams>
export const SendTransactionParams = funtypes.ReadonlyObject({
	method: funtypes.Literal('eth_sendTransaction'),
	params: funtypes.ReadonlyTuple(DappRequestTransaction)
})

export type SendRawTransactionParams = funtypes.Static<typeof SendRawTransactionParams>
export const SendRawTransactionParams = funtypes.ReadonlyObject({
	method: funtypes.Literal('eth_sendRawTransaction'),
	params: funtypes.ReadonlyTuple(EthereumData),
})

export type EthereumAccountsReply = funtypes.Static<typeof EthereumAccountsReply>
export const EthereumAccountsReply = funtypes.ReadonlyTuple(funtypes.ReadonlyArray(EthereumAddress), funtypes.Boolean)

export type EthereumChainReply = funtypes.Static<typeof EthereumChainReply>
export const EthereumChainReply = funtypes.ReadonlyArray(EthereumQuantity)

export type TransactionReceiptParams = funtypes.Static<typeof TransactionReceiptParams>
export const TransactionReceiptParams = funtypes.ReadonlyObject({
	method: funtypes.Literal('eth_getTransactionReceipt'),
	params: funtypes.ReadonlyTuple(EthereumBytes32)
})

export type EstimateGasParams = funtypes.Static<typeof EstimateGasParams>
export const EstimateGasParams = funtypes.ReadonlyObject({
	method: funtypes.Literal('eth_estimateGas'),
	params: funtypes.Union(funtypes.ReadonlyTuple(DappRequestTransaction), funtypes.ReadonlyTuple(DappRequestTransaction, EthereumBlockTag))
})

export type EthCallParams = funtypes.Static<typeof EthCallParams>
export const EthCallParams = funtypes.ReadonlyObject({
	method: funtypes.Literal('eth_call'),
	params: funtypes.ReadonlyTuple(
		DappRequestTransaction,
		EthereumBlockTag
	)
}).asReadonly()

export type EthGetLogsParams = funtypes.Static<typeof EthGetLogsParams>
export const EthGetLogsParams = funtypes.ReadonlyObject({
	method: funtypes.Literal('eth_getLogs'),
	params: funtypes.ReadonlyTuple(EthGetLogsRequest)
}).asReadonly()

export type EthBalanceParams = funtypes.Static<typeof EthBalanceParams>
export const EthBalanceParams = funtypes.ReadonlyObject({
	method: funtypes.Literal('eth_getBalance'),
	params: funtypes.ReadonlyTuple(EthereumAddress, EthereumBlockTag)
})

export type EthBlockByNumberParams = funtypes.Static<typeof EthBlockByNumberParams>
export const EthBlockByNumberParams = funtypes.ReadonlyObject({
	method: funtypes.Literal('eth_getBlockByNumber'),
	params: funtypes.ReadonlyTuple(EthereumBlockTag, funtypes.Boolean)
})

export type EthSubscribeParams = funtypes.Static<typeof EthSubscribeParams>
export const EthSubscribeParams = funtypes.ReadonlyObject({
	method: funtypes.Literal('eth_subscribe'),
	params: funtypes.ReadonlyTuple(funtypes.Union(funtypes.Literal('newHeads'), funtypes.Literal('logs'), funtypes.Literal('newPendingTransactions'), funtypes.Literal('syncing')))
})

export type EthUnSubscribeParams = funtypes.Static<typeof EthUnSubscribeParams>
export const EthUnSubscribeParams = funtypes.ReadonlyObject({
	method: funtypes.Literal('eth_unsubscribe'),
	params: funtypes.ReadonlyTuple(funtypes.String)
})

export type EthGetStorageAtParams = funtypes.Static<typeof EthGetStorageAtParams>
export const EthGetStorageAtParams = funtypes.ReadonlyObject({
	method: funtypes.Literal('eth_getStorageAt'),
	params: funtypes.ReadonlyTuple(EthereumAddress, EthereumQuantity, EthereumBlockTag)
})

export const EthSubscriptionResponse = funtypes.String
export type EthSubscriptionResponse = funtypes.Static<typeof EthSubscriptionResponse>

export type PersonalSignParams = funtypes.Static<typeof PersonalSignParams>
export const PersonalSignParams = funtypes.ReadonlyObject({
	method: funtypes.Literal('personal_sign'),
	params: funtypes.Union(
		funtypes.ReadonlyTuple(funtypes.String, EthereumAddress, funtypes.Union(funtypes.String, funtypes.Undefined, funtypes.Null)), // message, account, password
		funtypes.ReadonlyTuple(funtypes.String, EthereumAddress) // message, account
	)
})

type typeJSONEncodeable = string | number | boolean | { [x: string]: typeJSONEncodeable | undefined } | ReadonlyArray<typeJSONEncodeable>
export type JSONEncodeable = funtypes.Static<typeof JSONEncodeable>
export const JSONEncodeable: funtypes.Runtype<typeJSONEncodeable> = funtypes.Lazy(() => funtypes.Union(
	funtypes.String,
	funtypes.Boolean,
	funtypes.Number,
	funtypes.ReadonlyArray(JSONEncodeable),
	funtypes.ReadonlyRecord(funtypes.String, JSONEncodeable),
))

export type JSONEncodeableObject = funtypes.Static<typeof JSONEncodeableObject>
export const JSONEncodeableObject = funtypes.ReadonlyRecord(funtypes.String, JSONEncodeable)

export type JSONEncodeableObjectOrArray = funtypes.Static<typeof JSONEncodeableObjectOrArray>
export const JSONEncodeableObjectOrArray = funtypes.Union(funtypes.ReadonlyArray(JSONEncodeable), funtypes.ReadonlyRecord(funtypes.String, JSONEncodeable))

export type EIP712MessageUnderlying = funtypes.Static<typeof EIP712MessageUnderlying>
export const EIP712MessageUnderlying = funtypes.ReadonlyObject({
	types: funtypes.Record(funtypes.String, funtypes.ReadonlyArray(
		funtypes.ReadonlyObject({
			name: funtypes.String,
			type: funtypes.String,
		})
	)),
	primaryType: funtypes.String,
	domain: JSONEncodeableObject,
	message: JSONEncodeableObject,
})

export function isJSON(text: string){
	if (typeof text !== 'string') return false
	try {
		JSON.parse(text)
		return true
	}
	catch (error) {
		return false
	}
}

const EIP712MessageParser: funtypes.ParsedValue<funtypes.String, EIP712MessageUnderlying>['config'] = {
	parse: value => {
		if (!isJSON(value) || !EIP712MessageUnderlying.test(JSON.parse(value))) return { success: false, message: `${ value } is not EIP712 message` }
		else return { success: true, value: EIP712MessageUnderlying.parse(JSON.parse(value)) }
	},
	serialize: value => {
		if (!EIP712MessageUnderlying.test(value)) return { success: false, message: `${ value } is not a EIP712 message.`}
		return { success: true, value: JSON.stringify(EIP712MessageUnderlying.serialize(value)) }
	},
}

export type EIP712Message = funtypes.Static<typeof EIP712Message>
export const EIP712Message = funtypes.String.withParser(EIP712MessageParser)

export type OldSignTypedDataParams = funtypes.Static<typeof OldSignTypedDataParams>
export const OldSignTypedDataParams = funtypes.ReadonlyObject({
	method: funtypes.Literal('eth_signTypedData'),
	params: funtypes.ReadonlyTuple(funtypes.ReadonlyArray(
		funtypes.ReadonlyObject({
			name: funtypes.String,
			type: funtypes.String,
		})
	), EthereumAddress),
})

export type SignTypedDataParams = funtypes.Static<typeof SignTypedDataParams>
export const SignTypedDataParams = funtypes.ReadonlyObject({
	method: funtypes.Union(
		funtypes.Literal('eth_signTypedData_v1'),
		funtypes.Literal('eth_signTypedData_v2'),
		funtypes.Literal('eth_signTypedData_v3'),
		funtypes.Literal('eth_signTypedData_v4'),
	),
	params: funtypes.ReadonlyTuple(EthereumAddress, EIP712Message), // address that will sign the message, typed data
})
export type SwitchEthereumChainParams = funtypes.Static<typeof SwitchEthereumChainParams>
export const SwitchEthereumChainParams = funtypes.ReadonlyObject({
	method: funtypes.Literal('wallet_switchEthereumChain'),
	params: funtypes.Tuple(funtypes.ReadonlyObject({ chainId: EthereumQuantity }).asReadonly()),
}).asReadonly()

export type GetCode = funtypes.Static<typeof GetCode>
export const GetCode = funtypes.ReadonlyObject({
	method: funtypes.Literal('eth_getCode'),
	params: funtypes.ReadonlyTuple(EthereumAddress, EthereumBlockTag)
}).asReadonly()

export type RequestPermissions = funtypes.Static<typeof RequestPermissions>
export const RequestPermissions = funtypes.ReadonlyObject({
	method: funtypes.Literal('wallet_requestPermissions'),
	params: funtypes.ReadonlyTuple( funtypes.ReadonlyObject({ eth_accounts: funtypes.ReadonlyObject({ }) }) )
}).asReadonly()

export type GetTransactionCount = funtypes.Static<typeof GetTransactionCount>
export const GetTransactionCount = funtypes.ReadonlyObject({
	method: funtypes.Literal('eth_getTransactionCount'),
	params: funtypes.ReadonlyTuple(EthereumAddress, EthereumBlockTag)
}).asReadonly()

export type EthSign = funtypes.Static<typeof EthSign>
export const EthSign = funtypes.ReadonlyObject({
	method: funtypes.Literal('eth_sign'),
	params: funtypes.ReadonlyTuple(EthereumAddress, funtypes.String),
}).asReadonly()

export type GetSimulationStackReply = funtypes.Static<typeof GetSimulationStackReply>
export const GetSimulationStackReply = funtypes.ReadonlyArray(funtypes.Intersect(
	EthereumUnsignedTransaction,
	SingleMulticallResponse,
	funtypes.ReadonlyObject({
		realizedGasPrice: EthereumQuantity,
		gasLimit: EthereumQuantity,
	}).asReadonly(),
))

export type GetSimulationStack = funtypes.Static<typeof GetSimulationStack>
export const GetSimulationStack = funtypes.ReadonlyObject({
	method: funtypes.Literal('interceptor_getSimulationStack'),
	params: funtypes.ReadonlyTuple(funtypes.Literal('1.0.0')),
}).asReadonly()

export type WalletAddEthereumChain = funtypes.Static<typeof WalletAddEthereumChain>
export const WalletAddEthereumChain = funtypes.ReadonlyObject({
	method: funtypes.Literal('wallet_addEthereumChain'),
	params: funtypes.Intersect(
		funtypes.ReadonlyObject({
			chainId: EthereumQuantity,
			chainName: funtypes.String,
			nativeCurrency: funtypes.ReadonlyObject({
				name: funtypes.String,
				symbol: funtypes.String,
				decimals: funtypes.Number,
			}),
			rpcUrls: funtypes.ReadonlyArray(EthereumAddress),
		}),
		funtypes.Partial({
			blockExplorerUrls: funtypes.ReadonlyArray(funtypes.String),
			iconUrls: funtypes.ReadonlyArray(funtypes.String),
		}).asReadonly()
	)
})

export type EthereumJsonRpcRequest = funtypes.Static<typeof EthereumJsonRpcRequest>
export const EthereumJsonRpcRequest = funtypes.Union(
	EthBlockByNumberParams,
	EthBalanceParams,
	EstimateGasParams,
	TransactionByHashParams,
	TransactionReceiptParams,
	SendTransactionParams,
	SendRawTransactionParams,
	EthCallParams,
	EthSubscribeParams,
	EthUnSubscribeParams,
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_blockNumber') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_chainId') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('net_version') }),
	GetCode,
	PersonalSignParams,
	OldSignTypedDataParams,
	SignTypedDataParams,
	SwitchEthereumChainParams,
	RequestPermissions,
	funtypes.ReadonlyObject({ method: funtypes.Literal('wallet_getPermissions') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_accounts') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_requestAccounts') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_gasPrice') }),
	GetTransactionCount,
	GetSimulationStack,
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_multicall'), params: MulticallRequestParameters }),
	EthGetStorageAtParams,
	EthGetLogsParams,
	EthSign,
	ExecutionSpec383MultiCallParams,
	WalletAddEthereumChain,
)

// should be same as the above list, except with `params: funtypes.Unknown`
export type SupportedEthereumJsonRpcRequestMethods = funtypes.Static<typeof SupportedEthereumJsonRpcRequestMethods>
export const SupportedEthereumJsonRpcRequestMethods = funtypes.ReadonlyObject({
	method: funtypes.Union(EthereumJsonRpcRequest.alternatives[0].fields.method, ...EthereumJsonRpcRequest.alternatives.map(x => x.fields.method)),
})
