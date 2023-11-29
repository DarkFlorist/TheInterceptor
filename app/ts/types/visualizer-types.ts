
import * as funtypes from 'funtypes'
import { EthereumAddress, EthereumBytes32, EthereumData, EthereumInput, EthereumQuantity, EthereumSignedTransaction, EthereumTimestamp, EthereumUnsignedTransaction, OptionalEthereumAddress } from './wire-types.js'
import { RenameAddressCallBack } from './user-interface-types.js'
import { ERROR_INTERCEPTOR_GAS_ESTIMATION_FAILED } from '../utils/constants.js'
import { EthBalanceChanges, EthSubscribeParams, OriginalSendRequestParameters, SendRawTransactionParams, SendTransactionParams, SingleMulticallResponse } from './JsonRpc-types.js'
import { InterceptedRequest, WebsiteSocket } from '../utils/requests.js'
import { AddressBookEntry, Erc721Entry, Erc20TokenEntry, Erc1155Entry } from './addressBookTypes.js'
import { Website } from './websiteAccessTypes.js'
import { VisualizedPersonalSignRequest } from './personal-message-definitions.js'
import { RpcNetwork } from './rpc.js'
import { SignMessageParams } from './jsonRpc-signing-types.js'
import { PureGroupedSolidityType } from './solidityType.js'

export type NetworkPrice = funtypes.Static<typeof NetworkPrice>
export const NetworkPrice = funtypes.ReadonlyObject({
	quoteToken: funtypes.ReadonlyObject({ address: EthereumAddress, decimals: EthereumQuantity, symbol: funtypes.String }),
	priceSources: funtypes.ReadonlyObject({
		uniswapV2Like: funtypes.ReadonlyArray(funtypes.ReadonlyObject({ factory: EthereumQuantity, initCodeHash: funtypes.String })),
		uniswapV3Like: funtypes.ReadonlyArray(funtypes.ReadonlyObject({ factory: EthereumQuantity, initCodeHash: funtypes.String }))
	})
})

export type SolidityVariable = funtypes.Static<typeof SolidityVariable>
export const SolidityVariable = funtypes.ReadonlyObject({
	typeValue: PureGroupedSolidityType,
	paramName: funtypes.String
})

export type ParsedEvent = funtypes.Static<typeof ParsedEvent>
export const ParsedEvent = funtypes.ReadonlyObject({
	isParsed: funtypes.Literal('Parsed'),
	name: funtypes.String, // eg. 'Transfer'
	signature: funtypes.String, // eg. 'Transfer(address,address,uint256)'
	args: funtypes.ReadonlyArray(SolidityVariable), // TODO: add support for structs (abiV2)
	loggersAddress: EthereumAddress,
	data: EthereumInput,
	topics: funtypes.ReadonlyArray(EthereumBytes32),
})

export type NonParsedEvent = funtypes.Static<typeof NonParsedEvent>
export const NonParsedEvent = funtypes.ReadonlyObject({
	isParsed: funtypes.Literal('NonParsed'),
	loggersAddress: EthereumAddress,
	data: EthereumInput,
	topics: funtypes.ReadonlyArray(EthereumBytes32),
})

export type MaybeParsedEventWithExtraData = funtypes.Static<typeof MaybeParsedEventWithExtraData>
export const MaybeParsedEventWithExtraData = funtypes.Union(
	funtypes.Union(
		funtypes.Intersect(
			NonParsedEvent,
			funtypes.ReadonlyObject({ type: funtypes.Literal('NonParsed') })
		),
		funtypes.Intersect(
			ParsedEvent,
			funtypes.ReadonlyObject({ type: funtypes.Literal('Parsed') })
		),
		funtypes.Intersect(
			ParsedEvent,
			funtypes.ReadonlyObject({
				type: funtypes.Literal('TokenEvent'),
				tokenInformation: funtypes.Intersect(
					funtypes.ReadonlyObject( {
						from: EthereumAddress,
						to: EthereumAddress,
						tokenAddress: EthereumAddress,
					}),
					funtypes.Union(
						funtypes.ReadonlyObject({ // ERC20 transfer / approval
							amount: EthereumQuantity,
							type: funtypes.Literal('ERC20'),
							isApproval: funtypes.Boolean,
						}),
						funtypes.ReadonlyObject({ // ERC721 transfer / approval
							tokenId: EthereumQuantity,
							type: funtypes.Literal('ERC721'),
							isApproval: funtypes.Boolean,
						}),
						funtypes.ReadonlyObject({ // ERC721 all approval // all approval removal
							type: funtypes.Literal('NFT All approval'),
							allApprovalAdded: funtypes.Boolean, // true if approval is added, and false if removed
							isApproval: funtypes.Literal(true),
						}),
						funtypes.ReadonlyObject({
							type: funtypes.Literal('ERC1155'),
							operator: EthereumAddress,
							tokenId: EthereumQuantity,
							amount: EthereumQuantity,
							isApproval: funtypes.Literal(false),
						})
					)
				)
			})
		)
	)
)

export type TokenVisualizerErc20Event  = funtypes.Static<typeof TokenVisualizerErc20Event>
export const TokenVisualizerErc20Event = funtypes.ReadonlyObject({
	logObject: funtypes.Union(funtypes.Undefined, MaybeParsedEventWithExtraData),
	type: funtypes.Literal('ERC20'),
	from: AddressBookEntry,
	to: AddressBookEntry,
	token: Erc20TokenEntry,
	amount: EthereumQuantity,
	isApproval: funtypes.Boolean,
})

export type TokenVisualizerErc721Event  = funtypes.Static<typeof TokenVisualizerErc721Event>
export const TokenVisualizerErc721Event = funtypes.ReadonlyObject({
	logObject: funtypes.Union(funtypes.Undefined, MaybeParsedEventWithExtraData),
	type: funtypes.Literal('ERC721'),
	from: AddressBookEntry,
	to: AddressBookEntry,
	token: Erc721Entry,
	tokenId: EthereumQuantity,
	isApproval: funtypes.Boolean,
})

export type TokenVisualizerErc1155Event = funtypes.Static<typeof TokenVisualizerErc1155Event>
export const TokenVisualizerErc1155Event = funtypes.ReadonlyObject({
	logObject: funtypes.Union(funtypes.Undefined, MaybeParsedEventWithExtraData),
	type: funtypes.Literal('ERC1155'),
	from: AddressBookEntry,
	to: AddressBookEntry,
	token: Erc1155Entry,
	tokenId: EthereumQuantity,
	tokenIdName: funtypes.Union(funtypes.String, funtypes.Undefined),
	amount: EthereumQuantity,
	isApproval: funtypes.Literal(false),
})

export type TokenVisualizerNFTAllApprovalEvent = funtypes.Static<typeof TokenVisualizerNFTAllApprovalEvent>
export const TokenVisualizerNFTAllApprovalEvent = funtypes.ReadonlyObject({
	logObject: funtypes.Union(funtypes.Undefined, ParsedEvent),
	type: funtypes.Literal('NFT All approval'),
	from: AddressBookEntry,
	to: AddressBookEntry,
	token: funtypes.Union(Erc721Entry, Erc1155Entry),
	allApprovalAdded: funtypes.Boolean, // true if approval is added, and false if removed
	isApproval: funtypes.Literal(true),
})

export type TokenVisualizerResultWithMetadata = funtypes.Static<typeof TokenVisualizerResultWithMetadata>
export const TokenVisualizerResultWithMetadata = funtypes.Union(
	TokenVisualizerErc20Event,
	TokenVisualizerErc721Event,
	TokenVisualizerErc1155Event,
	TokenVisualizerNFTAllApprovalEvent,
)

export type MaybeParsedEvent = funtypes.Static<typeof MaybeParsedEvent>
export const MaybeParsedEvent = funtypes.Union(ParsedEvent, NonParsedEvent)

export type MaybeParsedEvents = funtypes.Static<typeof MaybeParsedEvents>
export const MaybeParsedEvents = funtypes.ReadonlyArray(MaybeParsedEvent)

export type TokenBalancesAfter = funtypes.Static<typeof TokenBalancesAfter>
export const TokenBalancesAfter = funtypes.ReadonlyArray(funtypes.ReadonlyObject({
	token: EthereumAddress,
	tokenId: funtypes.Union(EthereumQuantity, funtypes.Undefined),
	owner: EthereumAddress,
	balance: funtypes.Union(EthereumQuantity, funtypes.Undefined),
}))

export type EthBalanceChangesWithMetadata = funtypes.Static<typeof EthBalanceChangesWithMetadata>
export const EthBalanceChangesWithMetadata = funtypes.ReadonlyObject({
	address: AddressBookEntry,
	before: EthereumQuantity,
	after: EthereumQuantity,
})

export type SimulatedAndVisualizedTransactionBase = funtypes.Static<typeof SimulatedAndVisualizedTransactionBase>
export const SimulatedAndVisualizedTransactionBase = funtypes.Intersect(
	funtypes.ReadonlyObject({
		ethBalanceChanges: funtypes.ReadonlyArray(EthBalanceChangesWithMetadata),
		tokenBalancesAfter: TokenBalancesAfter,
		tokenResults: funtypes.ReadonlyArray(TokenVisualizerResultWithMetadata),
		website: Website,
		created: EthereumTimestamp,
		gasSpent: EthereumQuantity,
		realizedGasPrice: EthereumQuantity,
		quarantine: funtypes.Boolean,
		quarantineReasons: funtypes.ReadonlyArray(funtypes.String),
		events: funtypes.ReadonlyArray(MaybeParsedEventWithExtraData),
		transactionIdentifier: EthereumQuantity,
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
			type: funtypes.Literal('ERC20'),
			isApproval: funtypes.Boolean,
		}),
		funtypes.ReadonlyObject({ // ERC721 transfer / approval
			tokenId: EthereumQuantity,
			type: funtypes.Literal('ERC721'),
			isApproval: funtypes.Boolean,
		}),
		funtypes.ReadonlyObject({ // ERC721 all approval // all approval removal
			type: funtypes.Literal('NFT All approval'),
			allApprovalAdded: funtypes.Boolean, // true if approval is added, and false if removed
			isApproval: funtypes.Literal(true),
		}),
		funtypes.ReadonlyObject({
			type: funtypes.Literal('ERC1155'),
			operator: EthereumAddress,
			tokenId: EthereumQuantity,
			amount: EthereumQuantity,
			isApproval: funtypes.Literal(false),
		})
	)
)

export type VisualizerResult = funtypes.Static<typeof VisualizerResult>
export const VisualizerResult = funtypes.ReadonlyObject({
	ethBalanceChanges: EthBalanceChanges,
	events: funtypes.ReadonlyArray(MaybeParsedEventWithExtraData),
	blockNumber: EthereumQuantity,
})

export type ProtectorResults = funtypes.Static<typeof ProtectorResults>
export const ProtectorResults = funtypes.ReadonlyObject( {
	quarantine: funtypes.Boolean,
	quarantineReasons: funtypes.ReadonlyArray(funtypes.String),
})

export type SimulatedTransaction = funtypes.Static<typeof SimulatedTransaction>
export const SimulatedTransaction = funtypes.ReadonlyObject({
	multicallResponse: SingleMulticallResponse,
	signedTransaction: EthereumSignedTransaction,
	realizedGasPrice: EthereumQuantity,
	website: Website,
	created: EthereumTimestamp,
	tokenBalancesAfter: TokenBalancesAfter,
	originalRequestParameters: funtypes.Union(SendTransactionParams, SendRawTransactionParams),
	transactionIdentifier: EthereumQuantity,
})

export type EstimateGasError = funtypes.Static<typeof EstimateGasError>
export const EstimateGasError = funtypes.ReadonlyObject({
	error: funtypes.ReadonlyObject({
		code: funtypes.Literal(ERROR_INTERCEPTOR_GAS_ESTIMATION_FAILED),
		message: funtypes.String,
		data: funtypes.String
	})
})

export type WebsiteCreatedEthereumUnsignedTransaction = funtypes.Static<typeof WebsiteCreatedEthereumUnsignedTransaction>
export const WebsiteCreatedEthereumUnsignedTransaction = funtypes.ReadonlyObject({
	website: Website,
	created: EthereumTimestamp,
	originalRequestParameters: OriginalSendRequestParameters,
	transactionIdentifier: EthereumQuantity,
	success: funtypes.Literal(true),
	transaction: EthereumUnsignedTransaction,
})

export type FailedToCreateWebsiteCreatedEthereumUnsignedTransaction = funtypes.Static<typeof FailedToCreateWebsiteCreatedEthereumUnsignedTransaction>
export const FailedToCreateWebsiteCreatedEthereumUnsignedTransaction = funtypes.ReadonlyObject({
	website: Website,
	created: EthereumTimestamp,
	originalRequestParameters: OriginalSendRequestParameters,
	transactionIdentifier: EthereumQuantity,
	success: funtypes.Literal(false),
	error: EstimateGasError.fields.error
})

export type WebsiteCreatedEthereumUnsignedTransactionOrFailed = funtypes.Static<typeof WebsiteCreatedEthereumUnsignedTransactionOrFailed>
export const WebsiteCreatedEthereumUnsignedTransactionOrFailed = funtypes.Union(
	WebsiteCreatedEthereumUnsignedTransaction,
	FailedToCreateWebsiteCreatedEthereumUnsignedTransaction
)

export type SignedMessageTransaction = funtypes.Static<typeof SignedMessageTransaction>
export const SignedMessageTransaction = funtypes.ReadonlyObject({
	website: Website,
	created: EthereumTimestamp,
	fakeSignedFor: EthereumAddress,
	originalRequestParameters: SignMessageParams,
	request: InterceptedRequest,
	simulationMode: funtypes.Boolean,
})

export type SimulationState = funtypes.Static<typeof SimulationState>
export const SimulationState = funtypes.ReadonlyObject({
	prependTransactionsQueue: funtypes.ReadonlyArray(WebsiteCreatedEthereumUnsignedTransaction),
	simulatedTransactions: funtypes.ReadonlyArray(SimulatedTransaction),
	signedMessages: funtypes.ReadonlyArray(SignedMessageTransaction),
	blockNumber: EthereumQuantity,
	blockTimestamp: EthereumTimestamp,
	rpcNetwork: RpcNetwork,
	simulationConductedTimestamp: EthereumTimestamp,
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
	addressBookEntries: readonly AddressBookEntry[],
	simulatedAndVisualizedTransactions: readonly SimulatedAndVisualizedTransaction[],
	visualizedPersonalSignRequests: readonly VisualizedPersonalSignRequest[],
	rpcNetwork: RpcNetwork,
	tokenPrices: readonly TokenPriceEstimate[],
	activeAddress: bigint,
	namedTokenIds: readonly NamedTokenId[],
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
	simTx: SimulatedAndVisualizedTransaction
	simulationAndVisualisationResults: SimulationAndVisualisationResults
	removeTransaction: ((tx: SimulatedAndVisualizedTransaction) => void) | undefined
	activeAddress: bigint
	renameAddressCallBack: RenameAddressCallBack
	addressMetaData: readonly AddressBookEntry[]
}

export type Erc20WithAmount = Erc20TokenEntry & {
	amount: bigint,
}

export type Erc20TokenBalanceChange = Erc20TokenEntry & {
	changeAmount: bigint
	tokenPriceEstimate: TokenPriceEstimate | undefined
}

export type ERC20TokenApprovalChange = Erc20TokenEntry & {
	approvals: (AddressBookEntry & { change: bigint })[]
}

export type Erc721TokenApprovalChange = {
	tokenId: bigint
	tokenEntry: Erc721Entry
	approvedEntry: AddressBookEntry
}

export type Erc1155WithAmount = Erc1155Entry & { tokenId: bigint, amount: bigint }

export type SimulationUpdatingState = funtypes.Static<typeof SimulationUpdatingState>
export const SimulationUpdatingState = funtypes.Union(funtypes.Literal('updating'), funtypes.Literal('done'), funtypes.Literal('failed'))

export type SimulationResultState = funtypes.Static<typeof SimulationResultState>
export const SimulationResultState = funtypes.Union(funtypes.Literal('done'), funtypes.Literal('invalid'))

export type NamedTokenId = funtypes.Static<typeof NamedTokenId>
export const NamedTokenId = funtypes.ReadonlyObject({
	tokenAddress: EthereumAddress,
	tokenId: EthereumQuantity,
	tokenIdName: funtypes.String
})

export type CompleteVisualizedSimulation = funtypes.Static<typeof CompleteVisualizedSimulation>
export const CompleteVisualizedSimulation = funtypes.ReadonlyObject({
	visualizerResults: funtypes.ReadonlyArray(VisualizerResult),
	protectors: funtypes.ReadonlyArray(ProtectorResults),
	addressBookEntries: funtypes.ReadonlyArray(AddressBookEntry),
	tokenPrices: funtypes.ReadonlyArray(TokenPriceEstimate),
	namedTokenIds: funtypes.ReadonlyArray(NamedTokenId),
	simulationState: funtypes.Union(SimulationState, funtypes.Undefined),
	activeAddress: OptionalEthereumAddress,
	simulationUpdatingState: SimulationUpdatingState, 
	simulationResultState: SimulationResultState,
	simulationId: funtypes.Number,
	simulatedAndVisualizedTransactions: funtypes.ReadonlyArray(SimulatedAndVisualizedTransaction),
	visualizedPersonalSignRequests: funtypes.ReadonlyArray(VisualizedPersonalSignRequest),
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

export type VisualizedSimulatorState = funtypes.Static<typeof VisualizedSimulatorState>
export const VisualizedSimulatorState = funtypes.ReadonlyObject({
	visualizerResults: funtypes.ReadonlyArray(VisualizerResult),
	protectors: funtypes.ReadonlyArray(ProtectorResults),
	addressBookEntries: funtypes.ReadonlyArray(AddressBookEntry),
	tokenPrices: funtypes.ReadonlyArray(TokenPriceEstimate),
	namedTokenIds: funtypes.ReadonlyArray(NamedTokenId),
	simulationState: funtypes.Union(SimulationState),
	simulatedAndVisualizedTransactions: funtypes.ReadonlyArray(SimulatedAndVisualizedTransaction),
	visualizedPersonalSignRequests: funtypes.ReadonlyArray(VisualizedPersonalSignRequest),
})
