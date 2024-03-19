import * as funtypes from 'funtypes'
import { PopupOrTabId, Website } from './websiteAccessTypes.js'
import { ActiveAddressEntry, AddressBookEntry } from './addressBookTypes.js'
import { EthereumAddress, EthereumQuantity, EthereumTimestamp, OptionalEthereumAddress } from './wire-types.js'
import { SignerName } from './signerTypes.js'
import { InterceptedRequest, UniqueRequestIdentifier, WebsiteSocket } from '../utils/requests.js'
import { FailedToCreateWebsiteCreatedEthereumUnsignedTransaction, GeneralEnrichedEthereumEvent, NamedTokenId, ProtectorResults, SignedMessageTransaction, SimulatedAndVisualizedTransaction, SimulationState, TokenPriceEstimate, WebsiteCreatedEthereumUnsignedTransaction, WebsiteCreatedEthereumUnsignedTransactionOrFailed } from './visualizer-types.js'
import { VisualizedPersonalSignRequest } from './personal-message-definitions.js'
import { OriginalSendRequestParameters } from './JsonRpc-types.js'
import { SignMessageParams } from './jsonRpc-signing-types.js'

export type PendingAccessRequest = funtypes.Static<typeof PendingAccessRequest>
export const PendingAccessRequest = funtypes.ReadonlyObject({
	website: Website,
	requestAccessToAddress: funtypes.Union(ActiveAddressEntry, funtypes.Undefined),
	originalRequestAccessToAddress: funtypes.Union(ActiveAddressEntry, funtypes.Undefined),
	associatedAddresses: funtypes.ReadonlyArray(ActiveAddressEntry),
	signerAccounts: funtypes.ReadonlyArray(EthereumAddress),
	signerName: SignerName,
	simulationMode: funtypes.Boolean,
	popupOrTabId: PopupOrTabId,
	socket: WebsiteSocket,
	request: funtypes.Union(InterceptedRequest, funtypes.Undefined),
	activeAddress: OptionalEthereumAddress,
	accessRequestId: funtypes.String,
}).asReadonly()

export type PendingAccessRequests = funtypes.Static<typeof PendingAccessRequests>
export const PendingAccessRequests = funtypes.ReadonlyArray(PendingAccessRequest)

export interface PendingAccessRequestWithMetadata extends PendingAccessRequest {
	addressMetadata: [string, ActiveAddressEntry][],
}

export type ConfirmTransactionSimulationBaseData = funtypes.Static<typeof ConfirmTransactionSimulationBaseData>
export const ConfirmTransactionSimulationBaseData = funtypes.ReadonlyObject({
	activeAddress: EthereumAddress,
	simulationMode: funtypes.Boolean,
	uniqueRequestIdentifier: UniqueRequestIdentifier,
	transactionToSimulate: WebsiteCreatedEthereumUnsignedTransactionOrFailed,
	signerName: SignerName,
})

export type ConfirmTransactionDialogState = funtypes.Static<typeof ConfirmTransactionDialogState>
export const ConfirmTransactionDialogState = funtypes.Intersect(
	ConfirmTransactionSimulationBaseData, 
	funtypes.ReadonlyObject({
		eventsForEachTransaction: funtypes.ReadonlyArray(funtypes.ReadonlyArray(GeneralEnrichedEthereumEvent)),
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

export type PendingTransactionApprovalStatus = funtypes.Static<typeof PendingTransactionApprovalStatus>
export const PendingTransactionApprovalStatus = funtypes.Union(
	funtypes.ReadonlyObject({ status: funtypes.Union(funtypes.Literal('WaitingForUser'), funtypes.Literal('WaitingForSigner')) }),
	funtypes.ReadonlyObject({
		status: funtypes.Union(funtypes.Literal('SignerError')),
		code: funtypes.Number,
		message: funtypes.String,
	}),
)

export type SimulatedPendingTransactionBase = funtypes.Static<typeof SimulatedPendingTransactionBase>
export const SimulatedPendingTransactionBase = funtypes.ReadonlyObject({
	type: funtypes.Literal('Transaction'),
	popupOrTabId: PopupOrTabId,
	originalRequestParameters: OriginalSendRequestParameters,
	uniqueRequestIdentifier: UniqueRequestIdentifier,
	simulationMode: funtypes.Boolean,
	activeAddress: EthereumAddress,
	created: EthereumTimestamp,
	transactionIdentifier: EthereumQuantity,
	website: Website,
	approvalStatus: PendingTransactionApprovalStatus,
})

export type SimulatedPendingTransaction = funtypes.Static<typeof SimulatedPendingTransaction>
export const SimulatedPendingTransaction = funtypes.Intersect(
	SimulatedPendingTransactionBase,
	funtypes.ReadonlyObject({ simulationResults: ConfirmTransactionTransactionSingleVisualization }),
	funtypes.Union(
		funtypes.ReadonlyObject({
			transactionOrMessageCreationStatus: funtypes.Literal('Simulated'),
			transactionToSimulate: WebsiteCreatedEthereumUnsignedTransaction,
		}),
		funtypes.ReadonlyObject({
			transactionOrMessageCreationStatus: funtypes.Literal('FailedToSimulate'),
			transactionToSimulate: FailedToCreateWebsiteCreatedEthereumUnsignedTransaction,
		}),
	)
)

export type CraftingTransactionPendingTransaction = funtypes.Static<typeof CraftingTransactionPendingTransaction>
export const CraftingTransactionPendingTransaction = funtypes.Intersect(
	SimulatedPendingTransactionBase,
	funtypes.ReadonlyObject({ transactionOrMessageCreationStatus: funtypes.Literal('Crafting') })
)

export type WaitingForSimulationPendingTransaction = funtypes.Static<typeof WaitingForSimulationPendingTransaction>
export const WaitingForSimulationPendingTransaction = funtypes.Intersect(
	SimulatedPendingTransactionBase,
	funtypes.ReadonlyObject({
		transactionToSimulate: WebsiteCreatedEthereumUnsignedTransaction,
		transactionOrMessageCreationStatus: funtypes.Literal('Simulating')
	})
)

export type PendingTransaction = funtypes.Static<typeof PendingTransaction>
export const PendingTransaction = funtypes.Union(CraftingTransactionPendingTransaction, WaitingForSimulationPendingTransaction, SimulatedPendingTransaction)

export type PendingSignableMessage = funtypes.Static<typeof PendingSignableMessage>
export const PendingSignableMessage = funtypes.Intersect(
	funtypes.ReadonlyObject({
		type: funtypes.Literal('SignableMessage'),
		popupOrTabId: PopupOrTabId,
		originalRequestParameters: SignMessageParams,
		simulationMode: funtypes.Boolean,
		uniqueRequestIdentifier: UniqueRequestIdentifier,
		signedMessageTransaction: SignedMessageTransaction,
		created: EthereumTimestamp,
		website: Website,
		activeAddress: EthereumAddress,
		approvalStatus: PendingTransactionApprovalStatus,
	}),
	funtypes.Union(
		funtypes.ReadonlyObject({ transactionOrMessageCreationStatus: funtypes.Literal('Simulated'), visualizedPersonalSignRequest: VisualizedPersonalSignRequest }),
		funtypes.ReadonlyObject({ transactionOrMessageCreationStatus: funtypes.Union(funtypes.Literal('Crafting'), funtypes.Literal('Simulating')) })
	)
)

export type PendingTransactionOrSignableMessage = funtypes.Static<typeof PendingTransactionOrSignableMessage>
export const PendingTransactionOrSignableMessage = funtypes.Union(PendingSignableMessage, PendingTransaction)
