
import { EthBalanceChanges, EthereumAddress, EthereumData, EthereumQuantity, EthereumSignedTransaction, EthereumTimestamp, EthereumUnsignedTransaction, EthSubscribeParams, SingleMulticallResponse } from './wire-types.js'
import * as funtypes from 'funtypes'
import { QUARANTINE_CODE } from '../simulation/protectors/quarantine-codes.js'
import { AddressBookEntry, CHAIN, NFTEntry, RenameAddressCallBack, TokenEntry, Website, WebsiteSocket } from './user-interface-types.js'

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
			type: funtypes.Literal('Token'),
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

export type TokenVisualizerERC20Event  = funtypes.Static<typeof TokenVisualizerERC20Event>
export const TokenVisualizerERC20Event = funtypes.ReadonlyObject({
	type: funtypes.Literal('Token'),
	from: AddressBookEntry,
	to: AddressBookEntry,
	token: TokenEntry,
	amount: EthereumQuantity,
	isApproval: funtypes.Boolean,
})

export type TokenVisualizerERC721Event  = funtypes.Static<typeof TokenVisualizerERC721Event>
export const TokenVisualizerERC721Event = funtypes.ReadonlyObject({
	type: funtypes.Literal('NFT'),
	from: AddressBookEntry,
	to: AddressBookEntry,
	token: NFTEntry,
	tokenId: EthereumQuantity,
	isApproval: funtypes.Boolean,
})

export type TokenVisualizerERC721AllApprovalEvent  = funtypes.Static<typeof TokenVisualizerERC721AllApprovalEvent>
export const TokenVisualizerERC721AllApprovalEvent = funtypes.ReadonlyObject({
	type: funtypes.Literal('NFT All approval'),
	from: AddressBookEntry,
	to: AddressBookEntry,
	token: NFTEntry,
	allApprovalAdded: funtypes.Boolean, // true if approval is added, and false if removed
	isApproval: funtypes.Literal(true),
})

export type TokenVisualizerResultWithMetadata = funtypes.Static<typeof TokenVisualizerResultWithMetadata>
export const TokenVisualizerResultWithMetadata = funtypes.Union(
	TokenVisualizerERC20Event,
	TokenVisualizerERC721Event,
	TokenVisualizerERC721AllApprovalEvent,
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
	tokenBalancesAfter: TokenBalancesAfter,
})

export type EthereumUnsignedTransactionWithWebsite = funtypes.Static<typeof EthereumUnsignedTransactionWithWebsite>
export const EthereumUnsignedTransactionWithWebsite = funtypes.ReadonlyObject({
	transaction: EthereumUnsignedTransaction,
	website: Website
})

export type SimulationState = funtypes.Static<typeof SimulationState>
export const SimulationState = funtypes.ReadonlyObject({
	prependTransactionsQueue: funtypes.ReadonlyArray(EthereumUnsignedTransactionWithWebsite),
	simulatedTransactions: funtypes.ReadonlyArray(SimulatedTransaction),
	blockNumber: EthereumQuantity,
	blockTimestamp: EthereumTimestamp,
	chain: CHAIN,
	simulationConductedTimestamp: EthereumTimestamp,
})

export type EthBalanceChangesWithMetadata = {
	address: AddressBookEntry,
	before: bigint,
	after: bigint,
}

export type TransactionWithAddressBookEntries = funtypes.Static<typeof TransactionWithAddressBookEntries>
export const TransactionWithAddressBookEntries = funtypes.Intersect(
	funtypes.ReadonlyObject({
		from: AddressBookEntry,
		to: funtypes.Union(AddressBookEntry, funtypes.Undefined),
		value: EthereumQuantity,
		input: EthereumData,
		chainId: CHAIN,
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

export type SimulatedAndVisualizedTransaction = {
	transaction: TransactionWithAddressBookEntries
	ethBalanceChanges: readonly EthBalanceChangesWithMetadata[]
	tokenBalancesAfter: TokenBalancesAfter
	tokenResults: readonly TokenVisualizerResultWithMetadata[]
	website: Website
	gasSpent: EthereumQuantity
	realizedGasPrice: EthereumQuantity,
	quarantine: boolean
	quarantineCodes: readonly QUARANTINE_CODE[]
} & (
	{ statusCode: 'failure', error: string } |
	{ statusCode: 'success' }
)

export type SimulationAndVisualisationResults = {
	blockNumber: bigint,
	blockTimestamp: Date,
	simulationConductedTimestamp: Date,
	addressMetaData: readonly AddressBookEntry[],
	simulatedAndVisualizedTransactions: readonly SimulatedAndVisualizedTransaction[],
	chain: CHAIN,
	tokenPrices: readonly TokenPriceEstimate[],
	activeAddress: bigint,
}

export type TokenPriceEstimate = funtypes.Static<typeof TokenPriceEstimate>
export const TokenPriceEstimate = funtypes.ReadonlyObject({
	token: funtypes.String,
	inOutAmount: funtypes.ReadonlyTuple(EthereumQuantity, EthereumQuantity),
	decimals: EthereumQuantity,
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

export type ERC721TokenDefinitionParams = {
	id: bigint
	name: string
	address: bigint
	symbol: string
	logoUri?: string
}

export type ERC721TokenApprovalChange = {
	token: ERC721TokenDefinitionParams
	approvedEntry: AddressBookEntry
}

export type SimulationResults = funtypes.Static<typeof SimulationResults>
export const SimulationResults = funtypes.ReadonlyObject({
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

