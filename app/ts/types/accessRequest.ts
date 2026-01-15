import * as funtypes from 'funtypes'
import { PopupOrTabId, Website } from './websiteAccessTypes.js'
import { AddressBookEntry } from './addressBookTypes.js'
import { EthereumAddress, EthereumQuantity, EthereumTimestamp, OptionalEthereumAddress } from './wire-types.js'
import { SignerName } from './signerTypes.js'
import { InterceptedRequest, UniqueRequestIdentifier, WebsiteSocket } from '../utils/requests.js'
import { FailedToCreateWebsiteCreatedEthereumUnsignedTransaction, NamedTokenId, SignedMessageTransaction, SimulationState, TokenPriceEstimate, VisualizedSimulationState, WebsiteCreatedEthereumUnsignedTransaction, WebsiteCreatedEthereumUnsignedTransactionOrFailed } from './visualizer-types.js'
import { VisualizedPersonalSignRequest } from './personal-message-definitions.js'
import { OriginalSendRequestParameters } from './JsonRpc-types.js'
import { SignMessageParams } from './jsonRpc-signing-types.js'
import { DecodedError } from './error.js'

export type PendingAccessRequest = funtypes.Static<typeof PendingAccessRequest>
export const PendingAccessRequest = funtypes.ReadonlyObject({
	website: Website,
	requestAccessToAddress: funtypes.Union(AddressBookEntry, funtypes.Undefined),
	originalRequestAccessToAddress: funtypes.Union(AddressBookEntry, funtypes.Undefined),
	associatedAddresses: funtypes.ReadonlyArray(AddressBookEntry),
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

type ConfirmTransactionSimulationBaseData = funtypes.Static<typeof ConfirmTransactionSimulationBaseData>
const ConfirmTransactionSimulationBaseData = funtypes.ReadonlyObject({
	activeAddress: EthereumAddress,
	simulationMode: funtypes.Boolean,
	uniqueRequestIdentifier: UniqueRequestIdentifier,
	transactionToSimulate: WebsiteCreatedEthereumUnsignedTransactionOrFailed,
	signerName: SignerName,
})

type ConfirmTransactionDialogState = funtypes.Static<typeof ConfirmTransactionDialogState>
const ConfirmTransactionDialogState = funtypes.Intersect(
	ConfirmTransactionSimulationBaseData,
	funtypes.ReadonlyObject({
		addressBookEntries: funtypes.ReadonlyArray(AddressBookEntry),
		tokenPriceEstimates: funtypes.ReadonlyArray(TokenPriceEstimate),
		namedTokenIds: funtypes.ReadonlyArray(NamedTokenId),
		simulationState: SimulationState,
		activeAddress: OptionalEthereumAddress,
		visualizedSimulationState: VisualizedSimulationState
	}),
)

type ConfirmTransactionSimulationStateChanged = funtypes.Static<typeof ConfirmTransactionSimulationStateChanged>
const ConfirmTransactionSimulationStateChanged = funtypes.ReadonlyObject({
	statusCode: funtypes.Literal('success'),
	data: ConfirmTransactionDialogState
})

type ConfirmTransactionSimulationFailed = funtypes.Static<typeof ConfirmTransactionSimulationFailed>
const ConfirmTransactionSimulationFailed = funtypes.ReadonlyObject({
	statusCode: funtypes.Literal('failed'),
	data: funtypes.Intersect(
		ConfirmTransactionSimulationBaseData,
		funtypes.ReadonlyObject({
			error: DecodedError,
			simulationState: funtypes.ReadonlyObject({
				blockNumber: EthereumQuantity,
				simulationConductedTimestamp: EthereumTimestamp,
			})
		})
	)
}).asReadonly()

export type ConfirmTransactionTransactionSingleVisualization = funtypes.Static<typeof ConfirmTransactionTransactionSingleVisualization>
export const ConfirmTransactionTransactionSingleVisualization = funtypes.Union(ConfirmTransactionSimulationFailed, ConfirmTransactionSimulationStateChanged)

type PendingTransactionApprovalStatus = funtypes.Static<typeof PendingTransactionApprovalStatus>
const PendingTransactionApprovalStatus = funtypes.Union(
	funtypes.ReadonlyObject({ status: funtypes.Union(funtypes.Literal('WaitingForUser'), funtypes.Literal('WaitingForSigner')) }),
	funtypes.ReadonlyObject({
		status: funtypes.Union(funtypes.Literal('SignerError')),
		code: funtypes.Number,
		message: funtypes.String,
	}),
)

type SimulatedPendingTransactionBase = funtypes.Static<typeof SimulatedPendingTransactionBase>
const SimulatedPendingTransactionBase = funtypes.ReadonlyObject({
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
	funtypes.ReadonlyObject({ popupVisualisation: ConfirmTransactionTransactionSingleVisualization }),
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

type CraftingTransactionPendingTransaction = funtypes.Static<typeof CraftingTransactionPendingTransaction>
const CraftingTransactionPendingTransaction = funtypes.Intersect(
	SimulatedPendingTransactionBase,
	funtypes.ReadonlyObject({ transactionOrMessageCreationStatus: funtypes.Literal('Crafting') })
)

type WaitingForSimulationPendingTransaction = funtypes.Static<typeof WaitingForSimulationPendingTransaction>
const WaitingForSimulationPendingTransaction = funtypes.Intersect(
	SimulatedPendingTransactionBase,
	funtypes.ReadonlyObject({
		transactionToSimulate: WebsiteCreatedEthereumUnsignedTransaction,
		transactionOrMessageCreationStatus: funtypes.Literal('Simulating')
	})
)

export type PendingTransaction = funtypes.Static<typeof PendingTransaction>
export const PendingTransaction = funtypes.Union(CraftingTransactionPendingTransaction, WaitingForSimulationPendingTransaction, SimulatedPendingTransaction)

type PendingSignableMessage = funtypes.Static<typeof PendingSignableMessage>
const PendingSignableMessage = funtypes.Intersect(
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
