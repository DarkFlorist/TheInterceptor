
import * as funtypes from 'funtypes'
import { EthereumAddress, EthereumBytes32, EthereumData, EthereumQuantity, EthereumSendableSignedTransaction, EthereumTimestamp, EthereumUnsignedTransaction, OptionalEthereumAddress } from './wire-types.js'
import { RenameAddressCallBack } from './user-interface-types.js'
import { EthNewFilter, EthSubscribeParams, OriginalSendRequestParameters, SendRawTransactionParams, SendTransactionParams } from './JsonRpc-types.js'
import { InterceptedRequest, WebsiteSocket } from '../utils/requests.js'
import { AddressBookEntry, Erc721Entry, Erc20TokenEntry, IncompleteAddressBookEntry } from './addressBookTypes.js'
import { Website } from './websiteAccessTypes.js'
import { VisualizedPersonalSignRequest } from './personal-message-definitions.js'
import { RpcNetwork } from './rpc.js'
import { SignMessageParams } from './jsonRpc-signing-types.js'
import { TransactionOrMessageIdentifier } from './interceptor-messages.js'
import { EthSimulateV1CallResult, StateOverrides } from './ethSimulate-types.js'
import { EditEnsNamedHashCallBack } from '../components/subcomponents/ens.js'
import { EnrichedEthereumEventWithMetadata, EnrichedEthereumInputData } from './EnrichedEthereumData.js'

export type TokenBalancesAfter = funtypes.Static<typeof TokenBalancesAfter>
export const TokenBalancesAfter = funtypes.ReadonlyArray(funtypes.ReadonlyObject({
	token: EthereumAddress,
	tokenId: funtypes.Union(EthereumQuantity, funtypes.Undefined),
	owner: EthereumAddress,
	balance: funtypes.Union(EthereumQuantity, funtypes.Undefined),
}))

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

export type BlockTimeManipulationDeltaUnit = funtypes.Static<typeof BlockTimeManipulationDeltaUnit>
export const BlockTimeManipulationDeltaUnit = funtypes.Union(
	funtypes.Literal('Seconds'),
	funtypes.Literal('Minutes'),
	funtypes.Literal('Hours'),
	funtypes.Literal('Days'),
	funtypes.Literal('Weeks'),
	funtypes.Literal('Months'),
	funtypes.Literal('Years')
)
export type BlockTimeManipulation = funtypes.Static<typeof BlockTimeManipulation>
export const BlockTimeManipulation = funtypes.Union(
	funtypes.ReadonlyObject({
		type: funtypes.Literal('AddToTimestamp'),
		deltaToAdd: EthereumQuantity,
		deltaUnit: BlockTimeManipulationDeltaUnit,
	}),
	funtypes.ReadonlyObject({
		type: funtypes.Literal('SetTimetamp'),
		timeToSet: EthereumQuantity,
	}),
)

export type BlockTimeManipulationWithNoDelay = funtypes.Static<typeof BlockTimeManipulationWithNoDelay>
export const BlockTimeManipulationWithNoDelay = funtypes.Union(
	BlockTimeManipulation,
	funtypes.ReadonlyObject({
		type: funtypes.Literal('No Delay'),
	}),
)

export type SimulatedAndVisualizedTransactionBase = funtypes.Static<typeof SimulatedAndVisualizedTransactionBase>
export const SimulatedAndVisualizedTransactionBase = funtypes.Intersect(
	funtypes.ReadonlyObject({
		tokenBalancesAfter: TokenBalancesAfter,
		tokenPriceEstimates: funtypes.ReadonlyArray(TokenPriceEstimate),
		tokenPriceQuoteToken: funtypes.Union(Erc20TokenEntry, funtypes.Undefined),
		website: Website,
		created: EthereumTimestamp,
		gasSpent: EthereumQuantity,
		realizedGasPrice: EthereumQuantity,
		quarantine: funtypes.Boolean,
		quarantineReasons: funtypes.ReadonlyArray(funtypes.String),
		events: funtypes.ReadonlyArray(EnrichedEthereumEventWithMetadata),
		parsedInputData: EnrichedEthereumInputData,
		transactionIdentifier: EthereumQuantity,
	}),
	funtypes.Union(
		funtypes.ReadonlyObject({
			statusCode: funtypes.Literal('success'),
		}),
		funtypes.ReadonlyObject({
			statusCode: funtypes.Literal('failure'),
			error: funtypes.ReadonlyObject({
				code: funtypes.Number,
				message: funtypes.String,
				decodedErrorMessage: funtypes.String,
			})
		})
	)
)

export type ProtectorResults = funtypes.Static<typeof ProtectorResults>
export const ProtectorResults = funtypes.ReadonlyObject( {
	quarantine: funtypes.Boolean,
	quarantineReasons: funtypes.ReadonlyArray(funtypes.String),
})

export type PreSimulationTransaction = funtypes.Static<typeof PreSimulationTransaction>
export const PreSimulationTransaction = funtypes.ReadonlyObject({
	signedTransaction: EthereumSendableSignedTransaction,
	website: Website,
	created: EthereumTimestamp,
	originalRequestParameters: funtypes.Union(SendTransactionParams, SendRawTransactionParams),
	transactionIdentifier: EthereumQuantity,
})

export type SimulatedTransaction = funtypes.Static<typeof SimulatedTransaction>
export const SimulatedTransaction = funtypes.ReadonlyObject({
	realizedGasPrice: EthereumQuantity,
	preSimulationTransaction: PreSimulationTransaction,
	ethSimulateV1CallResult: EthSimulateV1CallResult,
	tokenBalancesAfter: TokenBalancesAfter,
})

export type EstimateGasError = funtypes.Static<typeof EstimateGasError>
export const EstimateGasError = funtypes.ReadonlyObject({
	error: funtypes.ReadonlyObject({
		code: funtypes.Number,
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
export const WebsiteCreatedEthereumUnsignedTransactionOrFailed = funtypes.Union(WebsiteCreatedEthereumUnsignedTransaction, FailedToCreateWebsiteCreatedEthereumUnsignedTransaction)

export type SignedMessageTransaction = funtypes.Static<typeof SignedMessageTransaction>
export const SignedMessageTransaction = funtypes.ReadonlyObject({
	website: Website,
	created: EthereumTimestamp,
	fakeSignedFor: EthereumAddress,
	originalRequestParameters: SignMessageParams,
	request: InterceptedRequest,
	simulationMode: funtypes.Boolean,
	messageIdentifier: EthereumQuantity,
})

export type SimulationStateInputBlock = funtypes.Static<typeof SimulationStateInputBlock>
export const SimulationStateInputBlock = funtypes.ReadonlyObject({
	stateOverrides: StateOverrides,
	transactions: funtypes.ReadonlyArray(PreSimulationTransaction),
	signedMessages: funtypes.ReadonlyArray(SignedMessageTransaction),
	blockTimeManipulation: BlockTimeManipulation,
})

export type SimulationStateInput = funtypes.Static<typeof SimulationStateInput>
export const SimulationStateInput = funtypes.ReadonlyObject({
	blocks: funtypes.ReadonlyArray(SimulationStateInputBlock)
})

export type SimulationStateInputMinimalDataBlock = funtypes.Static<typeof SimulationStateInputMinimalDataBlock>
export const SimulationStateInputMinimalDataBlock = funtypes.ReadonlyObject({
	stateOverrides: StateOverrides,
	transactions: funtypes.ReadonlyArray(funtypes.ReadonlyObject({ signedTransaction: EthereumSendableSignedTransaction })),
	signedMessages: funtypes.ReadonlyArray(SignedMessageTransaction),
	blockTimeManipulation: BlockTimeManipulation,
})

export type SimulationStateInputMinimalData = funtypes.Static<typeof SimulationStateInputMinimalData>
export const SimulationStateInputMinimalData = funtypes.ReadonlyObject({
	blocks: funtypes.ReadonlyArray(SimulationStateInputMinimalDataBlock)
})

export type SimulationStateBlock = funtypes.Static<typeof SimulationStateBlock>
export const SimulationStateBlock = funtypes.ReadonlyObject({
	stateOverrides: StateOverrides,
	simulatedTransactions: funtypes.ReadonlyArray(SimulatedTransaction),
	signedMessages: funtypes.ReadonlyArray(SignedMessageTransaction),
	blockTimestamp: EthereumTimestamp,
	blockTimeManipulation: BlockTimeManipulation,
})

export type SimulationState = funtypes.Static<typeof SimulationState>
export const SimulationState = funtypes.ReadonlyObject({
	simulatedBlocks: funtypes.ReadonlyArray(SimulationStateBlock),
	blockNumber: EthereumQuantity,
	blockTimestamp: EthereumTimestamp,
	baseFeePerGas: EthereumQuantity,
	simulationConductedTimestamp: EthereumTimestamp,
	rpcNetwork: RpcNetwork,
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
			type: funtypes.Union(funtypes.Literal('1559'), funtypes.Literal('7702')),
			maxFeePerGas: EthereumQuantity,
			maxPriorityFeePerGas: EthereumQuantity,
		}),
		funtypes.ReadonlyObject({
			type: funtypes.Literal('4844'),
			maxFeePerGas: EthereumQuantity,
			maxPriorityFeePerGas: EthereumQuantity,
			maxFeePerBlobGas: EthereumQuantity,
			blobVersionedHashes: funtypes.ReadonlyArray(EthereumBytes32),
		}),
		funtypes.ReadonlyObject({ type: funtypes.Union(funtypes.Literal('legacy'), funtypes.Literal('2930')) })
	)
)

export type SimulatedAndVisualizedTransaction = funtypes.Static<typeof SimulatedAndVisualizedTransaction>
export const SimulatedAndVisualizedTransaction = funtypes.Intersect(
	SimulatedAndVisualizedTransactionBase,
	funtypes.ReadonlyObject({ transaction: TransactionWithAddressBookEntries })
)

export type SimulationAndVisualisationResults = {
	blockNumber: bigint,
	blockTimestamp: Date,
	simulationConductedTimestamp: Date,
	addressBookEntries: readonly AddressBookEntry[],
	visualizedSimulationState: VisualizedSimulationState,
	rpcNetwork: RpcNetwork,
	tokenPriceEstimates: readonly TokenPriceEstimate[],
	activeAddress: bigint,
	namedTokenIds: readonly NamedTokenId[],
}

export type TransactionVisualizationParameters = {
	simTx: SimulatedAndVisualizedTransaction
	simulationAndVisualisationResults: SimulationAndVisualisationResults
	removeTransactionOrSignedMessage: ((transactionOrMessageIdentifier: TransactionOrMessageIdentifier) => void) | undefined
	activeAddress: bigint
	renameAddressCallBack: RenameAddressCallBack
	addressMetaData: readonly AddressBookEntry[]
	editEnsNamedHashCallBack: EditEnsNamedHashCallBack
}

export type Erc20TokenBalanceChange = Erc20TokenEntry & {
	changeAmount: bigint
	tokenPriceEstimateQuoteToken: Erc20TokenEntry | undefined
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

export type SimulationUpdatingState = funtypes.Static<typeof SimulationUpdatingState>
export const SimulationUpdatingState = funtypes.Union(funtypes.Literal('updating'), funtypes.Literal('done'), funtypes.Literal('failed'))

export type SimulationResultState = funtypes.Static<typeof SimulationResultState>
export const SimulationResultState = funtypes.Union(funtypes.Literal('done'), funtypes.Literal('invalid'), funtypes.Literal('corrupted'))

export type NamedTokenId = funtypes.Static<typeof NamedTokenId>
export const NamedTokenId = funtypes.ReadonlyObject({
	tokenAddress: EthereumAddress,
	tokenId: EthereumQuantity,
	tokenIdName: funtypes.String
})

export type VisualizedSimulationState = funtypes.Static<typeof VisualizedSimulationState>
export const VisualizedSimulationState = funtypes.ReadonlyObject({
	visualizedBlocks: funtypes.ReadonlyArray(funtypes.ReadonlyObject({
		simulatedAndVisualizedTransactions: funtypes.ReadonlyArray(SimulatedAndVisualizedTransaction),
		visualizedPersonalSignRequests: funtypes.ReadonlyArray(VisualizedPersonalSignRequest),
		blockTimeManipulation: BlockTimeManipulation
	}))
})

export type CompleteVisualizedSimulation = funtypes.Static<typeof CompleteVisualizedSimulation>
export const CompleteVisualizedSimulation = funtypes.ReadonlyObject({
	addressBookEntries: funtypes.ReadonlyArray(AddressBookEntry),
	tokenPriceEstimates: funtypes.ReadonlyArray(TokenPriceEstimate),
	tokenPriceQuoteToken: funtypes.Union(funtypes.Undefined, Erc20TokenEntry),
	namedTokenIds: funtypes.ReadonlyArray(NamedTokenId),
	simulationState: funtypes.Union(SimulationState, funtypes.Undefined),
	activeAddress: OptionalEthereumAddress,
	simulationUpdatingState: SimulationUpdatingState,
	simulationResultState: SimulationResultState,
	simulationId: funtypes.Number,
	visualizedSimulationState: VisualizedSimulationState,
	makeMeRich: funtypes.Boolean,
})

type NewHeadsSubscription = funtypes.Static<typeof NewHeadsSubscription>
const NewHeadsSubscription = funtypes.ReadonlyObject({
	type: funtypes.Literal('newHeads'),
	subscriptionOrFilterId: funtypes.String,
	params: EthSubscribeParams,
	subscriptionCreatorSocket: WebsiteSocket,
})

type NewEthfilter = funtypes.Static<typeof NewEthfilter>
const NewEthfilter = funtypes.ReadonlyObject({
	type: funtypes.Literal('eth_newFilter'),
	subscriptionOrFilterId: funtypes.String,
	params: EthNewFilter,
	subscriptionCreatorSocket: WebsiteSocket,
	calledInlastBlock: EthereumQuantity,
})

export type EthereumSubscriptionsAndFilters = funtypes.Static<typeof EthereumSubscriptionsAndFilters>
export const EthereumSubscriptionsAndFilters = funtypes.ReadonlyArray(funtypes.Union(NewEthfilter, NewHeadsSubscription))

export type VisualizedSimulatorState = funtypes.Static<typeof VisualizedSimulatorState>
export const VisualizedSimulatorState = funtypes.ReadonlyObject({
	addressBookEntries: funtypes.ReadonlyArray(AddressBookEntry),
	tokenPriceEstimates: funtypes.ReadonlyArray(TokenPriceEstimate),
	tokenPriceQuoteToken: funtypes.Union(Erc20TokenEntry, funtypes.Undefined),
	namedTokenIds: funtypes.ReadonlyArray(NamedTokenId),
	simulationState: funtypes.Union(SimulationState),
	visualizedSimulationState: VisualizedSimulationState,
})

type ModifyAddressWindowStateError = funtypes.Static<typeof ModifyAddressWindowStateError>
const ModifyAddressWindowStateError = funtypes.Union(funtypes.ReadonlyObject({ message: funtypes.String, blockEditing: funtypes.Boolean }), funtypes.Undefined)

export type ModifyAddressWindowState = funtypes.Static<typeof ModifyAddressWindowState>
export const ModifyAddressWindowState = funtypes.ReadonlyObject({
	windowStateId: funtypes.String,
	incompleteAddressBookEntry: IncompleteAddressBookEntry,
	errorState: ModifyAddressWindowStateError,
})

export type EditEnsNamedHashWindowState = funtypes.Static<typeof EditEnsNamedHashWindowState>
export const EditEnsNamedHashWindowState = funtypes.ReadonlyObject({
	type: funtypes.Union(funtypes.Literal('nameHash'), funtypes.Literal('labelHash')),
	nameHash: EthereumBytes32,
	name: funtypes.Union(funtypes.Undefined, funtypes.String)
})

export type InterceptorStackOperation = funtypes.Static<typeof InterceptorStackOperation>
export const InterceptorStackOperation = funtypes.Union(
	funtypes.ReadonlyObject({
		type: funtypes.Literal('Transaction'),
		preSimulationTransaction: PreSimulationTransaction
	}),
	funtypes.ReadonlyObject({
		type: funtypes.Literal('Message'),
		signedMessageTransaction: SignedMessageTransaction
	}),
	funtypes.ReadonlyObject({
		type: funtypes.Literal('TimeManipulation'),
		blockTimeManipulation: BlockTimeManipulation
}))

export type InterceptorTransactionStack = funtypes.Static<typeof InterceptorTransactionStack>
export const InterceptorTransactionStack = funtypes.ReadonlyObject({
	operations: funtypes.ReadonlyArray(InterceptorStackOperation),
})

const SignedBigIntParser: funtypes.ParsedValue<funtypes.String, bigint>['config'] = {
	parse: value => {
		if (!/^-?0x[a-fA-F0-9]{1,64}$/.test(value)) return { success: false, message: `${ value } is not a hex string encoded number.` }
		return { success: true, value: BigInt(value.startsWith('-') ? -value.slice(1) : value) }
	},
	serialize: value => {
		if (typeof value !== 'bigint') return { success: false, message: `${ typeof value } is not a bigint.` }
		return { success: true, value: value < 0 ? `-0x${ (-value).toString(16) }` : `0x${ value.toString(16) }` }
	}
}

export const SignedBigInt = funtypes.String.withParser(SignedBigIntParser)
export type SignedBigInt = funtypes.Static<typeof SignedBigInt>
