
import { EthereumAddress, EthereumData, EthereumQuantity, EthereumSignedTransaction, EthereumTimestamp, EthereumUnsignedTransaction } from './wire-types.js'
import * as funtypes from 'funtypes'
import { QUARANTINE_CODE } from '../simulation/protectors/quarantine-codes.js'
import { AddressBookEntry, NFTEntry, RenameAddressCallBack, Erc20TokenEntry, Website, WebsiteSocket } from './user-interface-types.js'
import { ERROR_INTERCEPTOR_GAS_ESTIMATION_FAILED } from './constants.js'
import { EthBalanceChanges, EthSubscribeParams, SingleMulticallResponse } from './JsonRpc-types.js'


export type NetworkPrice = funtypes.Static<typeof NetworkPrice>
export const NetworkPrice = funtypes.ReadonlyObject({
	quoteToken: funtypes.ReadonlyObject({ address: EthereumAddress, decimals: EthereumQuantity, symbol: funtypes.String }),
	priceSources: funtypes.ReadonlyObject({
		uniswapV2Like: funtypes.ReadonlyArray(funtypes.ReadonlyObject({ factory: EthereumQuantity, initCodeHash: funtypes.String })),
		uniswapV3Like: funtypes.ReadonlyArray(funtypes.ReadonlyObject({ factory: EthereumQuantity, initCodeHash: funtypes.String }))
	})
})

export type RpcEntry = funtypes.Static<typeof RpcEntry>
export const RpcEntry = funtypes.ReadonlyObject({
	name: funtypes.String,
	chainId: EthereumQuantity,
	httpsRpc: funtypes.String,
	currencyName: funtypes.String,
	currencyTicker: funtypes.String,
	primary: funtypes.Boolean,
	minimized: funtypes.Boolean,
	weth: EthereumQuantity,
})

export type RpcEntries = funtypes.Static<typeof RpcEntries>
export const RpcEntries = funtypes.ReadonlyArray(RpcEntry)

export type RpcNetwork = funtypes.Static<typeof RpcNetwork>
export const RpcNetwork = funtypes.Union(
	RpcEntry,
	funtypes.ReadonlyObject({
		httpsRpc: funtypes.Undefined,
		chainId: EthereumQuantity,
		name: funtypes.String,
		currencyName: funtypes.Literal('Ether?'),
    	currencyTicker: funtypes.Literal('ETH?'),
	})
)

export type OptionalEthereumAddress = funtypes.Static<typeof OptionalEthereumAddress>
export const OptionalEthereumAddress = funtypes.Union(EthereumAddress, funtypes.Undefined)

export type TokenVisualizerResult = funtypes.Static<typeof TokenVisualizerResult>
export const TokenVisualizerResult = funtypes.Intersect(
	funtypes.ReadonlyObject( {
		from: EthereumAddress,
		to: EthereumAddress,
		tokenAddress: EthereumAddress,
	}),
	funtypes.Union(
		funtypes.ReadonlyObject({ // ERC20 transfer / approval
			amount: EthereumQuantity,
			type: funtypes.Literal('Erc20Token'),
			isApproval: funtypes.Boolean,
		}),
		funtypes.ReadonlyObject({ // ERC721 transfer / approval
			tokenId: EthereumQuantity,
			type: funtypes.Literal('NFT'),
			isApproval: funtypes.Boolean,
		}),
		funtypes.ReadonlyObject({ // ERC721 all approval // all approval removal
			type: funtypes.Literal('NFT All approval'),
			allApprovalAdded: funtypes.Boolean, // true if approval is added, and false if removed
			isApproval: funtypes.Literal(true),
		})
	)
)

export type TokenVisualizerErc20Event  = funtypes.Static<typeof TokenVisualizerErc20Event>
export const TokenVisualizerErc20Event = funtypes.ReadonlyObject({
	type: funtypes.Literal('Erc20Token'),
	from: AddressBookEntry,
	to: AddressBookEntry,
	token: Erc20TokenEntry,
	amount: EthereumQuantity,
	isApproval: funtypes.Boolean,
})

export type TokenVisualizerErc721Event  = funtypes.Static<typeof TokenVisualizerErc721Event>
export const TokenVisualizerErc721Event = funtypes.ReadonlyObject({
	type: funtypes.Literal('NFT'),
	from: AddressBookEntry,
	to: AddressBookEntry,
	token: NFTEntry,
	tokenId: EthereumQuantity,
	isApproval: funtypes.Boolean,
})

export type TokenVisualizerErc721AllApprovalEvent  = funtypes.Static<typeof TokenVisualizerErc721AllApprovalEvent>
export const TokenVisualizerErc721AllApprovalEvent = funtypes.ReadonlyObject({
	type: funtypes.Literal('NFT All approval'),
	from: AddressBookEntry,
	to: AddressBookEntry,
	token: NFTEntry,
	allApprovalAdded: funtypes.Boolean, // true if approval is added, and false if removed
	isApproval: funtypes.Literal(true),
})

export type TokenVisualizerResultWithMetadata = funtypes.Static<typeof TokenVisualizerResultWithMetadata>
export const TokenVisualizerResultWithMetadata = funtypes.Union(
	TokenVisualizerErc20Event,
	TokenVisualizerErc721Event,
	TokenVisualizerErc721AllApprovalEvent,
)

export type VisualizerResult  = funtypes.Static<typeof VisualizerResult>
export const VisualizerResult = funtypes.ReadonlyObject( {
	ethBalanceChanges: EthBalanceChanges,
	tokenResults: funtypes.ReadonlyArray(TokenVisualizerResult),
	blockNumber: EthereumQuantity,
})

export type SimResults  = funtypes.Static<typeof SimResults>
export const SimResults = funtypes.ReadonlyObject( {
	quarantine: funtypes.Boolean,
	quarantineCodes: funtypes.ReadonlyArray(QUARANTINE_CODE),
	visualizerResults: funtypes.Union(VisualizerResult, funtypes.Undefined),
	website: Website,
})

export type TokenBalancesAfter = funtypes.Static<typeof TokenBalancesAfter>
export const TokenBalancesAfter = funtypes.ReadonlyArray(funtypes.ReadonlyObject({
	token: EthereumAddress,
	owner: EthereumAddress,
	balance: funtypes.Union(EthereumQuantity, funtypes.Undefined),
}))

export type SimulatedTransaction = funtypes.Static<typeof SimulatedTransaction>
export const SimulatedTransaction = funtypes.ReadonlyObject({
	multicallResponse: SingleMulticallResponse,
	signedTransaction: EthereumSignedTransaction,
	realizedGasPrice: EthereumQuantity,
	website: Website,
	transactionCreated: EthereumTimestamp,
	tokenBalancesAfter: TokenBalancesAfter,
	transactionSendingFormat: funtypes.Union(funtypes.Literal('eth_sendRawTransaction'), funtypes.Literal('eth_sendTransaction')),
})

export type WebsiteCreatedEthereumUnsignedTransaction = funtypes.Static<typeof WebsiteCreatedEthereumUnsignedTransaction>
export const WebsiteCreatedEthereumUnsignedTransaction = funtypes.ReadonlyObject({
	website: Website,
	transactionCreated: EthereumTimestamp,
	transaction: EthereumUnsignedTransaction,
	transactionSendingFormat: funtypes.Union(funtypes.Literal('eth_sendRawTransaction'), funtypes.Literal('eth_sendTransaction')),
})

export type EstimateGasError = funtypes.Static<typeof EstimateGasError>
export const EstimateGasError = funtypes.ReadonlyObject({
	error: funtypes.ReadonlyObject({
		code: funtypes.Literal(ERROR_INTERCEPTOR_GAS_ESTIMATION_FAILED),
		message: funtypes.String,
		data: funtypes.String
	})
})

export type SimulationState = funtypes.Static<typeof SimulationState>
export const SimulationState = funtypes.ReadonlyObject({
	prependTransactionsQueue: funtypes.ReadonlyArray(WebsiteCreatedEthereumUnsignedTransaction),
	simulatedTransactions: funtypes.ReadonlyArray(SimulatedTransaction),
	blockNumber: EthereumQuantity,
	blockTimestamp: EthereumTimestamp,
	rpcNetwork: RpcNetwork,
	simulationConductedTimestamp: EthereumTimestamp,
})
export type EthBalanceChangesWithMetadata = funtypes.Static<typeof EthBalanceChangesWithMetadata>
export const EthBalanceChangesWithMetadata = funtypes.ReadonlyObject({
	address: AddressBookEntry,
	before: EthereumQuantity,
	after: EthereumQuantity,
})

export type TransactionWithAddressBookEntries = funtypes.Static<typeof TransactionWithAddressBookEntries>
export const TransactionWithAddressBookEntries = funtypes.Intersect(
	funtypes.ReadonlyObject({
		from: AddressBookEntry,
		to: funtypes.Union(AddressBookEntry, funtypes.Undefined),
		value: EthereumQuantity,
		input: EthereumData,
		rpcNetwork: RpcNetwork,
		hash: EthereumQuantity,
		gas: EthereumQuantity,
		nonce: EthereumQuantity,
	}),
	funtypes.Union(
		funtypes.ReadonlyObject({
			type: funtypes.Literal('1559'),
			maxFeePerGas: EthereumQuantity,
			maxPriorityFeePerGas: EthereumQuantity,
		}),
		funtypes.ReadonlyObject({ type: funtypes.Union(funtypes.Literal('legacy'), funtypes.Literal('2930')) })
	)
)
export type SimulatedAndVisualizedTransactionBase = funtypes.Static<typeof SimulatedAndVisualizedTransactionBase>
export const SimulatedAndVisualizedTransactionBase = funtypes.Intersect(
	funtypes.ReadonlyObject({
		ethBalanceChanges: funtypes.ReadonlyArray(EthBalanceChangesWithMetadata),
		tokenBalancesAfter: TokenBalancesAfter,
		tokenResults: funtypes.ReadonlyArray(TokenVisualizerResultWithMetadata),
		website: Website,
		transactionCreated: EthereumTimestamp,
		gasSpent: EthereumQuantity,
		realizedGasPrice: EthereumQuantity,
		quarantine: funtypes.Boolean,
		quarantineCodes: funtypes.ReadonlyArray(QUARANTINE_CODE),
	}),
	funtypes.Union(
		funtypes.ReadonlyObject({
			statusCode: funtypes.Literal('success'),
		}),
		funtypes.ReadonlyObject({
			statusCode: funtypes.Literal('failure'),
			error: funtypes.String
		})
	)
)

export type SimulatedAndVisualizedTransaction = funtypes.Static<typeof SimulatedAndVisualizedTransaction>
export const SimulatedAndVisualizedTransaction = funtypes.Intersect(
	SimulatedAndVisualizedTransactionBase,
	funtypes.ReadonlyObject({
		transaction: TransactionWithAddressBookEntries,
	})
)

export type SimulationAndVisualisationResults = {
	blockNumber: bigint,
	blockTimestamp: Date,
	simulationConductedTimestamp: Date,
	addressMetaData: readonly AddressBookEntry[],
	simulatedAndVisualizedTransactions: readonly SimulatedAndVisualizedTransaction[],
	rpcNetwork: RpcNetwork,
	tokenPrices: readonly TokenPriceEstimate[],
	activeAddress: bigint,
}

export type TokenPriceEstimate = funtypes.Static<typeof TokenPriceEstimate>
export const TokenPriceEstimate = funtypes.ReadonlyObject({
	token: funtypes.ReadonlyObject({
		address: EthereumAddress,
		decimals: EthereumQuantity
	}),
	quoteToken: funtypes.ReadonlyObject({
		address: EthereumAddress,
		decimals: EthereumQuantity
	}),
	price: EthereumQuantity
})

export type TransactionVisualizationParameters = {
	simTx: SimulatedAndVisualizedTransaction,
	simulationAndVisualisationResults: SimulationAndVisualisationResults,
	removeTransaction: (tx: SimulatedAndVisualizedTransaction) => void,
	activeAddress: bigint,
	renameAddressCallBack: RenameAddressCallBack,
}

export type TokenDefinitionParams = {
	name: string
	address: bigint
	symbol: string
	decimals: bigint
	logoUri?: string
}

export type TokenBalanceChange = TokenDefinitionParams & {
	changeAmount: bigint
	tokenPriceEstimate: TokenPriceEstimate | undefined
}

export type TokenApprovalChange = TokenDefinitionParams & {
	approvals: (AddressBookEntry & { change: bigint })[]
}

export type Erc721TokenDefinitionParams = {
	id: bigint
	name: string
	address: bigint
	symbol: string
	logoUri?: string
}

export type Erc721TokenApprovalChange = {
	token: Erc721TokenDefinitionParams
	approvedEntry: AddressBookEntry
}

export type SimulationUpdatingState = funtypes.Static<typeof SimulationUpdatingState>
export const SimulationUpdatingState = funtypes.Union(funtypes.Literal('updating'), funtypes.Literal('done'), funtypes.Literal('failed'))

export type SimulationResultState = funtypes.Static<typeof SimulationResultState>
export const SimulationResultState = funtypes.Union(funtypes.Literal('done'), funtypes.Literal('invalid'))

export type SimulationResults = funtypes.Static<typeof SimulationResults>
export const SimulationResults = funtypes.ReadonlyObject({
	simulationUpdatingState: SimulationUpdatingState, 
	simulationResultState: SimulationResultState,
	simulationId: funtypes.Number,
	simulationState: funtypes.Union(SimulationState, funtypes.Undefined),
	visualizerResults: funtypes.Union(funtypes.ReadonlyArray(SimResults), funtypes.Undefined),
	addressBookEntries: funtypes.ReadonlyArray(AddressBookEntry),
	tokenPrices: funtypes.ReadonlyArray(TokenPriceEstimate),
	activeAddress: OptionalEthereumAddress,
})

export type NewHeadsSubscription = funtypes.Static<typeof NewHeadsSubscription>
export const NewHeadsSubscription = funtypes.ReadonlyObject({
	type: funtypes.Literal('newHeads'),
	subscriptionId: funtypes.String,
	params: EthSubscribeParams,
	subscriptionCreatorSocket: WebsiteSocket,
})

export type EthereumSubscription = funtypes.Static<typeof EthereumSubscription>
export const EthereumSubscription = funtypes.Union(NewHeadsSubscription)

export type EthereumSubscriptions = funtypes.Static<typeof EthereumSubscriptions>
export const EthereumSubscriptions = funtypes.ReadonlyArray(EthereumSubscription)
