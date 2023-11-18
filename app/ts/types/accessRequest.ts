import * as funtypes from 'funtypes'
import { Website } from './websiteAccessTypes.js'
import { ActiveAddress, ActiveAddressEntry, AddressBookEntry } from './addressBookTypes.js'
import { EthereumAddress, EthereumQuantity, EthereumTimestamp, OptionalEthereumAddress } from './wire-types.js'
import { SignerName } from './signerTypes.js'
import { InterceptedRequest, UniqueRequestIdentifier, WebsiteSocket } from '../utils/requests.js'
import { NamedTokenId, ProtectorResults, SimulatedAndVisualizedTransaction, SimulationState, TokenPriceEstimate, VisualizerResult, WebsiteCreatedEthereumUnsignedTransaction } from './visualizer-types.js'
import { VisualizedPersonalSignRequest } from './personal-message-definitions.js'
import { OriginalSendRequestParameters } from './JsonRpc-types.js'

export type PendingAccessRequest = funtypes.Static<typeof PendingAccessRequest>
export const PendingAccessRequest = funtypes.ReadonlyObject({
	website: Website,
	requestAccessToAddress: funtypes.Union(ActiveAddressEntry, funtypes.Undefined),
	originalRequestAccessToAddress: funtypes.Union(ActiveAddressEntry, funtypes.Undefined),
	associatedAddresses: funtypes.ReadonlyArray(ActiveAddressEntry),
	activeAddresses: funtypes.ReadonlyArray(ActiveAddress),
	signerAccounts: funtypes.ReadonlyArray(EthereumAddress),
	signerName: SignerName,
	simulationMode: funtypes.Boolean,
	dialogId: funtypes.Number,
	socket: WebsiteSocket,
	request: funtypes.Union(InterceptedRequest, funtypes.Undefined),
	activeAddress: OptionalEthereumAddress,
	accessRequestId: funtypes.String,
}).asReadonly()

export type PendingAccessRequestArray = funtypes.Static<typeof PendingAccessRequestArray>
export const PendingAccessRequestArray = funtypes.ReadonlyArray(PendingAccessRequest)

export interface PendingAccessRequestWithMetadata extends PendingAccessRequest {
	addressMetadata: [string, ActiveAddressEntry][],
}

export type ConfirmTransactionSimulationBaseData = funtypes.Static<typeof ConfirmTransactionSimulationBaseData>
export const ConfirmTransactionSimulationBaseData = funtypes.ReadonlyObject({
	activeAddress: EthereumAddress,
	simulationMode: funtypes.Boolean,
	uniqueRequestIdentifier: UniqueRequestIdentifier,
	transactionToSimulate: WebsiteCreatedEthereumUnsignedTransaction,
	signerName: SignerName,
})

export type ConfirmTransactionDialogState = funtypes.Static<typeof ConfirmTransactionDialogState>
export const ConfirmTransactionDialogState = funtypes.Intersect(
	ConfirmTransactionSimulationBaseData, 
	funtypes.ReadonlyObject({
		visualizerResults: funtypes.ReadonlyArray(VisualizerResult),
		protectors: funtypes.ReadonlyArray(ProtectorResults),
		addressBookEntries: funtypes.ReadonlyArray(AddressBookEntry),
		tokenPrices: funtypes.ReadonlyArray(TokenPriceEstimate),
		namedTokenIds: funtypes.ReadonlyArray(NamedTokenId),
		simulationState: funtypes.Union(SimulationState),
		activeAddress: OptionalEthereumAddress,
		simulatedAndVisualizedTransactions: funtypes.ReadonlyArray(SimulatedAndVisualizedTransaction),
		visualizedPersonalSignRequests: funtypes.ReadonlyArray(VisualizedPersonalSignRequest),
	}),
)

export type ConfirmTransactionSimulationStateChanged = funtypes.Static<typeof ConfirmTransactionSimulationStateChanged>
export const ConfirmTransactionSimulationStateChanged = funtypes.ReadonlyObject({
	statusCode: funtypes.Literal('success'),
	data: ConfirmTransactionDialogState
})

export type ConfirmTransactionSimulationFailed = funtypes.Static<typeof ConfirmTransactionSimulationFailed>
export const ConfirmTransactionSimulationFailed = funtypes.ReadonlyObject({
	statusCode: funtypes.Literal('failed'),
	data: ConfirmTransactionSimulationBaseData,
}).asReadonly()

export type ConfirmTransactionTransactionSingleVisualization = funtypes.Static<typeof ConfirmTransactionTransactionSingleVisualization>
export const ConfirmTransactionTransactionSingleVisualization = funtypes.Union(ConfirmTransactionSimulationFailed, ConfirmTransactionSimulationStateChanged)

export type SimulatedPendingTransactionBase = funtypes.Static<typeof SimulatedPendingTransactionBase>
export const SimulatedPendingTransactionBase = funtypes.ReadonlyObject({
	dialogId: funtypes.Number,
	originalRequestParameters: OriginalSendRequestParameters,
	uniqueRequestIdentifier: UniqueRequestIdentifier,
	simulationMode: funtypes.Boolean,
	activeAddress: EthereumAddress,
	created: EthereumTimestamp,
	transactionIdentifier: EthereumQuantity,
})

export type SimulatedPendingTransaction = funtypes.Static<typeof SimulatedPendingTransaction>
export const SimulatedPendingTransaction = funtypes.Intersect(
	SimulatedPendingTransactionBase,
	funtypes.ReadonlyObject({
		status: funtypes.Literal('Simulated'),
		simulationResults: ConfirmTransactionTransactionSingleVisualization,
		transactionToSimulate: WebsiteCreatedEthereumUnsignedTransaction,
	})
)

export type CraftingTransactionPendingTransaction = funtypes.Static<typeof CraftingTransactionPendingTransaction>
export const CraftingTransactionPendingTransaction = funtypes.Intersect(
	SimulatedPendingTransactionBase,
	funtypes.ReadonlyObject({ status: funtypes.Literal('Crafting Transaction') })
)

export type WaitingForSimulationPendingTransaction = funtypes.Static<typeof WaitingForSimulationPendingTransaction>
export const WaitingForSimulationPendingTransaction = funtypes.Intersect(
	SimulatedPendingTransactionBase,
	funtypes.ReadonlyObject({
		transactionToSimulate: WebsiteCreatedEthereumUnsignedTransaction,
		status: funtypes.Literal('Simulating')
	})
)

export type PendingTransaction = funtypes.Static<typeof PendingTransaction>
export const PendingTransaction = funtypes.Union(CraftingTransactionPendingTransaction, WaitingForSimulationPendingTransaction, SimulatedPendingTransaction)
