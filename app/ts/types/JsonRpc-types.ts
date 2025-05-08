import * as funtypes from 'funtypes'
import { EthereumAddress, EthereumBlockHeader, EthereumBlockHeaderWithTransactionHashes, EthereumBlockTag, EthereumBytes256, EthereumBytes32, EthereumData, EthereumInput, EthereumQuantity, LiteralConverterParserFactory } from './wire-types.js'
import { areEqualUint8Arrays } from '../utils/typed-arrays.js'
import { EthSimulateV1Params } from './ethSimulate-types.js'
import { OldSignTypedDataParams, PersonalSignParams, SignTypedDataParams } from './jsonRpc-signing-types.js'
import { CodeMessageError } from './rpc.js'

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
		address: funtypes.Union(EthereumAddress, funtypes.ReadonlyArray(EthereumAddress), funtypes.Null),
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

export type EthGetFeeHistoryResponse = funtypes.Static<typeof EthGetFeeHistoryResponse>
export const EthGetFeeHistoryResponse = funtypes.Intersect(
	funtypes.ReadonlyObject({
		baseFeePerGas: funtypes.ReadonlyArray(EthereumQuantity),
		gasUsedRatio: funtypes.ReadonlyArray(funtypes.Number),
		oldestBlock: EthereumQuantity,
	}),
	funtypes.ReadonlyPartial({
		reward: funtypes.ReadonlyArray(funtypes.ReadonlyArray(EthereumQuantity))
	})
)

export type EthBalanceChanges = funtypes.Static<typeof EthBalanceChanges>
export const EthBalanceChanges = funtypes.ReadonlyArray(
	funtypes.ReadonlyObject({
		address: EthereumAddress,
		before: EthereumQuantity,
		after: EthereumQuantity,
	}).asReadonly()
)

export type PartialEthereumTransaction = funtypes.Static<typeof PartialEthereumTransaction>
export const PartialEthereumTransaction = funtypes.ReadonlyPartial({
	from: EthereumAddress,
	gas: EthereumQuantity,
	value: EthereumQuantity,
	to: funtypes.Union(EthereumAddress, funtypes.Null),
	gasPrice: EthereumQuantity,
	maxPriorityFeePerGas: funtypes.Union(EthereumQuantity, funtypes.Null), // etherscan sets this field to null, remove this if etherscan fixes this
	maxFeePerGas: funtypes.Union(EthereumQuantity, funtypes.Null), // etherscan sets this field to null, remove this if etherscan fixes this
	data: EthereumData,
	input: EthereumData,
}).withConstraint((PartialEthereumTransaction) => {
	if (PartialEthereumTransaction.input !== undefined && PartialEthereumTransaction.data !== undefined) {
		return areEqualUint8Arrays(PartialEthereumTransaction.input, PartialEthereumTransaction.data)
	}
	return true
})
.withConstraint((x) => {
	if (x.gasPrice !== undefined) return x.maxPriorityFeePerGas === undefined && x.maxFeePerGas === undefined
	if (x.maxPriorityFeePerGas !== undefined) return x.maxFeePerGas !== undefined && x.gasPrice === undefined
	if (x.maxFeePerGas !== undefined) return x.gasPrice === undefined /* && x.maxPriorityFeePerGas !== undefined*/ //Remix doesn't send "maxPriorityFeePerGas" with "maxFeePerGas"
  return true
})

export type EthTransactionReceiptResponse = funtypes.Static<typeof EthTransactionReceiptResponse>
export const EthTransactionReceiptResponse = funtypes.Union(
	funtypes.Null,
	funtypes.Intersect(
		funtypes.MutablePartial({
			author: EthereumAddress,
		}),
		funtypes.Intersect(
			funtypes.Union(
				funtypes.ReadonlyObject({
					type: funtypes.Union(
						funtypes.Union(funtypes.Literal('0x0').withParser(LiteralConverterParserFactory('0x0', 'legacy' as const)), funtypes.Literal(undefined).withParser(LiteralConverterParserFactory(undefined, 'legacy' as const))),
						funtypes.Literal('0x0').withParser(LiteralConverterParserFactory('0x0', 'legacy' as const)),
						funtypes.Literal('0x1').withParser(LiteralConverterParserFactory('0x1', '2930' as const)),
						funtypes.Literal('0x2').withParser(LiteralConverterParserFactory('0x2', '1559' as const)),
					),
				}),
				funtypes.ReadonlyObject({
					type: funtypes.Literal('0x4').withParser(LiteralConverterParserFactory('0x4', '7702' as const)),
					authorizationList: funtypes.ReadonlyArray(funtypes.ReadonlyObject({
						chainId: EthereumQuantity,
						address: EthereumAddress,
						nonce: EthereumQuantity,
						yParity: funtypes.Union(funtypes.Literal('0x0').withParser(LiteralConverterParserFactory('0x0', 'even' as const)), funtypes.Literal('0x1').withParser(LiteralConverterParserFactory('0x1', 'odd' as const))),
						r: EthereumQuantity,
						s: EthereumQuantity
					}))
				}),
				funtypes.ReadonlyObject({
					type: funtypes.Literal('0x3').withParser(LiteralConverterParserFactory('0x3', '4844' as const)),
					blobGasUsed: EthereumQuantity,
					blobGasPrice: EthereumQuantity,
				}),
			),
			funtypes.ReadonlyObject({
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
			})
		)
	)
)

export type GetBlockReturn = funtypes.Static<typeof GetBlockReturn>
export const GetBlockReturn = funtypes.Union(EthereumBlockHeader, EthereumBlockHeaderWithTransactionHashes)

type JsonRpcSuccessResponse = funtypes.Static<typeof JsonRpcSuccessResponse>
const JsonRpcSuccessResponse = funtypes.ReadonlyObject({
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

export type JsonRpcResponse = funtypes.Static<typeof JsonRpcResponse>
export const JsonRpcResponse = funtypes.Union(JsonRpcErrorResponse, JsonRpcSuccessResponse)

export type TransactionByHashParams = funtypes.Static<typeof TransactionByHashParams>
export const TransactionByHashParams = funtypes.ReadonlyObject({
	method: funtypes.Literal('eth_getTransactionByHash'),
	params: funtypes.ReadonlyTuple(EthereumBytes32)
})

export type SendTransactionParams = funtypes.Static<typeof SendTransactionParams>
export const SendTransactionParams = funtypes.ReadonlyObject({
	method: funtypes.Literal('eth_sendTransaction'),
	params: funtypes.ReadonlyTuple(PartialEthereumTransaction)
})

export type SendRawTransactionParams = funtypes.Static<typeof SendRawTransactionParams>
export const SendRawTransactionParams = funtypes.ReadonlyObject({
	method: funtypes.Literal('eth_sendRawTransaction'),
	params: funtypes.ReadonlyTuple(EthereumData),
})

export type EthereumAccountsReply = funtypes.Static<typeof EthereumAccountsReply>
export const EthereumAccountsReply = funtypes.ReadonlyTuple(
	funtypes.Union(
		funtypes.ReadonlyObject({
			type: funtypes.Literal('success'),
			accounts: funtypes.ReadonlyArray(EthereumAddress),
			requestAccounts: funtypes.Boolean,
		}),
		funtypes.ReadonlyObject({
			type: funtypes.Literal('error'),
			requestAccounts: funtypes.Boolean,
			error: CodeMessageError,
		})
	)
)

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
	params: funtypes.Union(funtypes.ReadonlyTuple(PartialEthereumTransaction), funtypes.ReadonlyTuple(PartialEthereumTransaction, EthereumBlockTag))
})

export type EthCallParams = funtypes.Static<typeof EthCallParams>
export const EthCallParams = funtypes.ReadonlyObject({
	method: funtypes.Literal('eth_call'),
	params: funtypes.ReadonlyTuple(
		PartialEthereumTransaction,
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

export type EthBlockByHashParams = funtypes.Static<typeof EthBlockByHashParams>
export const EthBlockByHashParams = funtypes.ReadonlyObject({
	method: funtypes.Literal('eth_getBlockByHash'),
	params: funtypes.ReadonlyTuple(EthereumBytes32, funtypes.Boolean)
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

type RequestPermissions = funtypes.Static<typeof RequestPermissions>
const RequestPermissions = funtypes.ReadonlyObject({
	method: funtypes.Literal('wallet_requestPermissions'),
	params: funtypes.ReadonlyTuple( funtypes.ReadonlyObject({ eth_accounts: funtypes.ReadonlyObject({ }) }) )
}).asReadonly()

export type GetTransactionCount = funtypes.Static<typeof GetTransactionCount>
export const GetTransactionCount = funtypes.ReadonlyObject({
	method: funtypes.Literal('eth_getTransactionCount'),
	params: funtypes.ReadonlyTuple(EthereumAddress, EthereumBlockTag)
}).asReadonly()

type EthSign = funtypes.Static<typeof EthSign>
const EthSign = funtypes.ReadonlyObject({
	method: funtypes.Literal('eth_sign'),
	params: funtypes.ReadonlyTuple(EthereumAddress, funtypes.String),
}).asReadonly()

export type GetSimulationStack = funtypes.Static<typeof GetSimulationStack>
export const GetSimulationStack = funtypes.ReadonlyObject({
	method: funtypes.Literal('interceptor_getSimulationStack'),
	params: funtypes.ReadonlyTuple(funtypes.Union(funtypes.Literal('1.0.0'), funtypes.Literal('1.0.1'), funtypes.Literal('2.0.0')))
}).asReadonly()

export type WalletAddEthereumChain = funtypes.Static<typeof WalletAddEthereumChain>
export const WalletAddEthereumChain = funtypes.ReadonlyObject({
	method: funtypes.Literal('wallet_addEthereumChain'),
	params: funtypes.Tuple(funtypes.Intersect(
		funtypes.ReadonlyObject({
			chainId: EthereumQuantity,
			chainName: funtypes.String,
			nativeCurrency: funtypes.ReadonlyObject({
				name: funtypes.String,
				symbol: funtypes.String,
				decimals: funtypes.Number,
			}),
			rpcUrls: funtypes.ReadonlyArray(funtypes.String),
		}),
		funtypes.Partial({
			blockExplorerUrls: funtypes.ReadonlyArray(funtypes.String),
			iconUrls: funtypes.ReadonlyArray(funtypes.String),
		}).asReadonly()
	))
})

type Web3ClientVersion = funtypes.Static<typeof Web3ClientVersion>
const Web3ClientVersion = funtypes.ReadonlyObject({
	method: funtypes.Literal('web3_clientVersion'),
	params: funtypes.ReadonlyTuple()
})

//https://docs.infura.io/networks/ethereum/json-rpc-methods/eth_feehistory
const EthereumQuantityBetween1And1024 = EthereumQuantity.withConstraint((x) => x >= 1n && x <= 1024n)

export type FeeHistory = funtypes.Static<typeof FeeHistory>
export const FeeHistory = funtypes.ReadonlyObject({
	method: funtypes.Literal('eth_feeHistory'),
	params: funtypes.Union(
		funtypes.ReadonlyTuple(EthereumQuantityBetween1And1024, EthereumBlockTag),
		funtypes.ReadonlyTuple(EthereumQuantityBetween1And1024, EthereumBlockTag, funtypes.ReadonlyArray(funtypes.Number))
	)
})

export type EthNewFilter = funtypes.Static<typeof EthNewFilter>
export const EthNewFilter = funtypes.ReadonlyObject({
	method: funtypes.Literal('eth_newFilter'),
	params: funtypes.ReadonlyTuple(funtypes.ReadonlyPartial({
		fromBlock: EthereumBlockTag,
		toBlock: EthereumBlockTag,
		address: EthereumAddress,
		topics: funtypes.ReadonlyArray(funtypes.Union(EthereumBytes32, funtypes.ReadonlyArray(EthereumBytes32), funtypes.Null)),
		blockhash: EthereumBytes32,
	}))
})

export type UninstallFilter = funtypes.Static<typeof UninstallFilter>
export const UninstallFilter = funtypes.ReadonlyObject({
	method: funtypes.Literal('eth_uninstallFilter'),
	params: funtypes.ReadonlyTuple(funtypes.String)
})

export type GetFilterChanges = funtypes.Static<typeof GetFilterChanges>
export const GetFilterChanges = funtypes.ReadonlyObject({
	method: funtypes.Literal('eth_getFilterChanges'),
	params: funtypes.ReadonlyTuple(funtypes.String)
})

export type GetFilterLogs = funtypes.Static<typeof GetFilterLogs>
export const GetFilterLogs = funtypes.ReadonlyObject({
	method: funtypes.Literal('eth_getFilterLogs'),
	params: funtypes.ReadonlyTuple(funtypes.String)
})

export type InterceptorError = funtypes.Static<typeof InterceptorError>
export const InterceptorError = funtypes.ReadonlyObject({
	method: funtypes.Literal('InterceptorError'),
	params: funtypes.Unknown,
})

export type EthereumJsonRpcRequest = funtypes.Static<typeof EthereumJsonRpcRequest>
export const EthereumJsonRpcRequest = funtypes.Union(
	EthBlockByNumberParams,
	EthBlockByHashParams,
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
	SignTypedDataParams,
	OldSignTypedDataParams,
	SwitchEthereumChainParams,
	RequestPermissions,
	funtypes.ReadonlyObject({ method: funtypes.Literal('wallet_getPermissions') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_accounts') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_requestAccounts') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('eth_gasPrice') }),
	GetTransactionCount,
	GetSimulationStack,
	EthGetStorageAtParams,
	EthGetLogsParams,
	EthSign,
	EthSimulateV1Params,
	WalletAddEthereumChain,
	Web3ClientVersion,
	FeeHistory,
	EthNewFilter,
	UninstallFilter,
	GetFilterChanges,
	GetFilterLogs,
	InterceptorError,
)

// should be same as the above list, except with `params: funtypes.Unknown`
export type SupportedEthereumJsonRpcRequestMethods = funtypes.Static<typeof SupportedEthereumJsonRpcRequestMethods>
export const SupportedEthereumJsonRpcRequestMethods = funtypes.ReadonlyObject({
	method: funtypes.Union(EthereumJsonRpcRequest.alternatives[0].fields.method, ...EthereumJsonRpcRequest.alternatives.map(x => x.fields.method)),
})

export type OriginalSendRequestParameters = funtypes.Static<typeof OriginalSendRequestParameters>
export const OriginalSendRequestParameters = funtypes.Union(SendTransactionParams, SendRawTransactionParams)
