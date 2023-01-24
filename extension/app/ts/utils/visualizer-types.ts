
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

export type TokenVisualizerResultWithMetadata = funtypes.Static<typeof TokenVisualizerResultWithMetadata>
export const TokenVisualizerResultWithMetadata = funtypes.Intersect(
	funtypes.Object( {
		from: AddressBookEntry,
		to: AddressBookEntry,
	}),
	funtypes.Union(
		funtypes.Object({ // ERC20 transfer / approval
			token: TokenEntry,
			amount: EthereumQuantity,
			is721: funtypes.Literal(false),
			isApproval: funtypes.Boolean,
		}),
		funtypes.Object({ // ERC721 transfer / approval
			token: NFTEntry,
			tokenId: EthereumQuantity,
			is721: funtypes.Literal(true),
			isApproval: funtypes.Boolean,
		}),
		funtypes.Object({ // ERC721 all approval // all approval removal
			token: NFTEntry,
			is721: funtypes.Literal(true),
			isAllApproval: funtypes.Boolean,
			allApprovalAdded: funtypes.Boolean, // true if approval is added, and false if removed
			isApproval: funtypes.Literal(true),
		})
	)
)

export type VisualizerResult = {
	readonly ethBalanceChanges: EthBalanceChanges
	readonly tokenResults: TokenVisualizerResult[]
	readonly blockNumber: bigint
}

export type SimResults = {
	quarantine: boolean,
	quarantineCodes: QUARANTINE_CODE[],
	visualizerResults: VisualizerResult | undefined,
}

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

export type SimulatedAndVisualizedTransaction = {
	multicallResponse: SingleMulticallResponse
	unsignedTransaction: EthereumUnsignedTransaction
	signedTransaction: (IUnsignedTransaction & EthereumTransactionSignature)
	realizedGasPrice: bigint
	simResults: SimResults | undefined
}

export type SimulationAndVisualisationResults = {
	blockNumber: bigint,
	blockTimestamp: Date,
	simulationConductedTimestamp: Date,
	simulatedAndVisualizedTransactions: SimulatedAndVisualizedTransaction[],
	addressMetadata: Map<string, AddressBookEntry>,
	chain: CHAIN,
	tokenPrices: TokenPriceEstimate[],
	activeAddress: bigint,
	simulationMode: boolean,
	isComputingSimulation: boolean,
}

export type BalanceChangeSummary = {
	ERC721TokenBalanceChanges: Map<string, Map<string, boolean > >, // token address, token id, {true if received, false if sent}
	ERC721OperatorChanges: Map<string, string | undefined> // token address, operator
	ERC721TokenIdApprovalChanges: Map<string, Map<string, string > > // token address, tokenId, approved address

	tokenBalanceChanges: Map<string, bigint>, // token address, amount
	tokenApprovalChanges: Map<string, Map<string, bigint > > // token address, approved address, amount
	etherResults: {
		balanceBefore: bigint,
		balanceAfter: bigint,
	} | undefined
}

export type TokenPriceEstimate = funtypes.Static<typeof TokenPriceEstimate>
export const TokenPriceEstimate = funtypes.Object({
	token: funtypes.String,
	inOutAmount: funtypes.ReadonlyTuple(EthereumQuantity, EthereumQuantity),
	decimals: EthereumQuantity,
})

export type TransactionVisualizationParameters = {
	tx: SimulatedAndVisualizedTransaction,
	from: AddressBookEntry,
	to: AddressBookEntry,
	simulationAndVisualisationResults: SimulationAndVisualisationResults,
	removeTransaction: (hash: bigint) => void,
	activeAddress: bigint,
	renameAddressCallBack: RenameAddressCallBack,
}
