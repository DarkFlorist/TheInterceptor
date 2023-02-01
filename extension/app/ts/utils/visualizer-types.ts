
import { IUnsignedTransaction } from './ethereum.js'
import { EthBalanceChanges, EthereumAddress, EthereumQuantity, EthereumTransactionSignature, EthereumUnsignedTransaction, SingleMulticallResponse } from './wire-types.js'
import * as funtypes from 'funtypes'
import { QUARANTINE_CODE } from '../simulation/protectors/quarantine-codes.js'
import { AddressBookEntry, CHAIN, NFTEntry, RenameAddressCallBack, TokenEntry } from './user-interface-types.js'

export type TokenVisualizerResult = funtypes.Static<typeof TokenVisualizerResult>
export const TokenVisualizerResult = funtypes.Intersect(
	funtypes.Object( {
		from: EthereumAddress,
		to: EthereumAddress,
		tokenAddress: EthereumAddress,
	}),
	funtypes.Union(
		funtypes.Object({ // ERC20 transfer / approval
			amount: EthereumQuantity,
			is721: funtypes.Literal(false),
			isApproval: funtypes.Boolean,
		}),
		funtypes.Object({ // ERC721 transfer / approval
			tokenId: EthereumQuantity,
			is721: funtypes.Literal(true),
			isApproval: funtypes.Boolean,
		}),
		funtypes.Object({ // ERC721 all approval // all approval removal
			is721: funtypes.Literal(true),
			isAllApproval: funtypes.Boolean,
			allApprovalAdded: funtypes.Boolean, // true if approval is added, and false if removed
			isApproval: funtypes.Literal(true),
		})
	)
)

export type TokenVisualizerERC20Event  = funtypes.Static<typeof TokenVisualizerERC20Event>
export const TokenVisualizerERC20Event = funtypes.Object( {
	from: AddressBookEntry,
	to: AddressBookEntry,
	token: TokenEntry,
	amount: EthereumQuantity,
	is721: funtypes.Literal(false),
	isApproval: funtypes.Boolean,
})

export type TokenVisualizerERC721Event  = funtypes.Static<typeof TokenVisualizerERC721Event>
export const TokenVisualizerERC721Event = funtypes.Object( {
	from: AddressBookEntry,
	to: AddressBookEntry,
	token: NFTEntry,
	tokenId: EthereumQuantity,
	is721: funtypes.Literal(true),
	isApproval: funtypes.Boolean,
})

export type TokenVisualizerERC721AllApprovalEvent  = funtypes.Static<typeof TokenVisualizerERC721AllApprovalEvent>
export const TokenVisualizerERC721AllApprovalEvent = funtypes.Object( {
	from: AddressBookEntry,
	to: AddressBookEntry,
	token: NFTEntry,
	is721: funtypes.Literal(true),
	isAllApproval: funtypes.Boolean,
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
export const VisualizerResult = funtypes.Object( {
	ethBalanceChanges: EthBalanceChanges,
	tokenResults: funtypes.ReadonlyArray(TokenVisualizerResult),
	blockNumber: EthereumQuantity,
})

export type SimResults  = funtypes.Static<typeof SimResults>
export const SimResults = funtypes.Object( {
	quarantine: funtypes.Boolean,
	quarantineCodes: funtypes.ReadonlyArray(QUARANTINE_CODE),
	visualizerResults: funtypes.Union(VisualizerResult, funtypes.Undefined),
})

export type SimulatedTransaction = {
	multicallResponse: SingleMulticallResponse,
	unsignedTransaction: EthereumUnsignedTransaction,
	signedTransaction: (IUnsignedTransaction & EthereumTransactionSignature),
	realizedGasPrice: bigint,
}

export type SimulationState = {
	simulatedTransactions: SimulatedTransaction[],
	blockNumber: bigint,
	blockTimestamp: Date,
	chain: CHAIN,
	simulationConductedTimestamp: Date,
}

export type EthBalanceChangesWithMetadata = {
	address: AddressBookEntry,
	before: bigint,
	after: bigint,
}

export type SimulatedAndVisualizedTransaction = {
	from: AddressBookEntry
	to: AddressBookEntry | undefined
	value: EthereumQuantity
	realizedGasPrice: EthereumQuantity
	ethBalanceChanges: EthBalanceChangesWithMetadata[]
	tokenResults: TokenVisualizerResultWithMetadata[]
	gasSpent: EthereumQuantity
	quarantine: boolean
	quarantineCodes: QUARANTINE_CODE[]
	input: Uint8Array
	chainId: CHAIN
	hash: bigint
	gas: bigint
} & ({
	type: '1559'
	maxFeePerGas: EthereumQuantity
	maxPriorityFeePerGas: EthereumQuantity
} | {
	type: 'legacy' | '2930'
}) & (
	{ statusCode: 'failure', error: string } |
	{ statusCode: 'success' }
)

export type SimulationAndVisualisationResults = {
	blockNumber: bigint,
	blockTimestamp: Date,
	simulationConductedTimestamp: Date,
	addressMetaData: Map<string, AddressBookEntry >
	simulatedAndVisualizedTransactions: SimulatedAndVisualizedTransaction[],
	chain: CHAIN,
	tokenPrices: TokenPriceEstimate[],
	activeAddress: bigint,
	simulationMode: boolean,
	isComputingSimulation: boolean,
}

export type TokenPriceEstimate = funtypes.Static<typeof TokenPriceEstimate>
export const TokenPriceEstimate = funtypes.Object({
	token: funtypes.String,
	inOutAmount: funtypes.ReadonlyTuple(EthereumQuantity, EthereumQuantity),
	decimals: EthereumQuantity,
})

export type TransactionVisualizationParameters = {
	tx: SimulatedAndVisualizedTransaction,
	simulationAndVisualisationResults: SimulationAndVisualisationResults,
	removeTransaction: (hash: bigint) => void,
	activeAddress: bigint,
	renameAddressCallBack: RenameAddressCallBack,
}

export type TokenDefinitionParams = {
	tokenName: string
	tokenAddress: bigint
	tokenSymbol: string
	tokenDecimals: bigint
	tokenLogoUri: string | undefined
}

export type TokenBalanceChange = TokenDefinitionParams & {
	changeAmount: bigint
	tokenPriceEstimate: TokenPriceEstimate | undefined
}

export type TokenApprovalChange = TokenDefinitionParams & {
	approvals: (AddressBookEntry & { change: bigint })[]
}

export type ERC721TokenDefinitionParams = {
	tokenId: bigint
	tokenName: string
	tokenAddress: bigint
	tokenSymbol: string
	tokenLogoUri: string | undefined
}

export type ERC721TokenApprovalChange = {
	token: ERC721TokenDefinitionParams
	approvedEntry: AddressBookEntry
}
