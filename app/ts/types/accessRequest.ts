import * as funtypes from 'funtypes'
import { PopupOrTabId, Website } from './websiteAccessTypes.js'
import { AddressBookEntry } from './addressBookTypes.js'
import { EthereumAddress, EthereumQuantity, EthereumTimestamp, OptionalEthereumAddress } from './wire-types.js'
import { SignerName } from './signerTypes.js'
import { InterceptedRequest, UniqueRequestIdentifier, WebsiteSocket } from '../utils/requests.js'
import { FailedToCreateWebsiteCreatedEthereumTransaction, NamedTokenId, RecordedVisualisationLookups, SignedMessageTransaction, SimulationState, TokenPriceEstimate, VisualizedSimulationState, WebsiteCreatedEthereumTransaction, WebsiteCreatedEthereumTransactionOrFailed } from './visualizer-types.js'
import { VisualizedPersonalSignRequest } from './personal-message-definitions.js'
import { OriginalSendRequestParameters, SendTransactionParams } from './JsonRpc-types.js'
import { SignMessageParams } from './jsonRpc-signing-types.js'
import { DecodedError } from './error.js'
import { SafeContractStateSnapshot, SafeMessageCoSignSnapshot, SafeSignerErrorDetails, SafeTransactionSigningRequest } from './safeTypes.js'

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
	simulationStartedTimestamp: EthereumTimestamp,
	uniqueRequestIdentifier: UniqueRequestIdentifier,
	transactionToSimulate: WebsiteCreatedEthereumTransactionOrFailed,
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

type ConfirmTransactionSimulationFailedData = funtypes.Static<typeof ConfirmTransactionSimulationFailedData>
const ConfirmTransactionSimulationFailedData = funtypes.Intersect(
	ConfirmTransactionSimulationBaseData,
	funtypes.ReadonlyObject({
		error: DecodedError,
		simulationState: funtypes.ReadonlyObject({
			blockNumber: EthereumQuantity,
			simulationConductedTimestamp: EthereumTimestamp,
		})
	})
)

type ConfirmTransactionSimulationFailed = funtypes.Static<typeof ConfirmTransactionSimulationFailed>
const ConfirmTransactionSimulationFailed = funtypes.ReadonlyObject({
	statusCode: funtypes.Literal('failed'),
	data: ConfirmTransactionSimulationFailedData
}).asReadonly()

export type ConfirmTransactionTransactionSingleVisualization = funtypes.Static<typeof ConfirmTransactionTransactionSingleVisualization>
export const ConfirmTransactionTransactionSingleVisualization = funtypes.Union(ConfirmTransactionSimulationFailed, ConfirmTransactionSimulationStateChanged)

// What background storage keeps of a confirmation run beside its visualisation, as the stored stack keeps its recordedVisualisationLookups beside its result. It is a sibling of popupVisualisation, never part of it, so the stored visualisation is exactly what the dialog is sent, and a popup projection only drops this one field (toPopupPendingTransactionOrSignableMessage in confirmTransaction.ts).
export type ConfirmationRunRecord = funtypes.Static<typeof ConfirmationRunRecord>
const ConfirmationRunRecord = funtypes.ReadonlyObject({
	// Identifies the confirmation simulation run that produced the visualisation beside it.
	confirmationRunId: funtypes.Number,
	// The address-book revision (getAddressBookRevision in storageVariables.ts) the run read when it started, before its first lookup; only the workflow that stores the run compares it, within the same background session.
	addressBookRevisionBeforeLookups: funtypes.Number,
}).And(funtypes.ReadonlyPartial({
	// What a successful run recorded of its lookups, so a re-label can visualise it again without the node; a failed run has nothing to re-label.
	recordedVisualisationLookups: RecordedVisualisationLookups,
}))

type PendingTransactionApprovalStatus = funtypes.Static<typeof PendingTransactionApprovalStatus>
const PendingTransactionApprovalStatus = funtypes.Union(
	funtypes.ReadonlyObject({ status: funtypes.Union(funtypes.Literal('WaitingForUser'), funtypes.Literal('WaitingForSigner')) }),
	funtypes.ReadonlyObject({
		status: funtypes.Union(funtypes.Literal('SignerError')),
		code: funtypes.Number,
		message: funtypes.String,
	}).And(funtypes.ReadonlyPartial({ safeSignerErrorDetails: SafeSignerErrorDetails })),
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
}).And(funtypes.ReadonlyPartial({
	safeTransaction: SafeTransactionSigningRequest,
	safeExecutionSignerAddress: EthereumAddress,
	safeExecutionOriginalRequestParameters: SendTransactionParams,
	safeExecutionReviewedSafeState: SafeContractStateSnapshot,
	// The confirmation's decision, made once by prepareSafeTransactionConfirmation in simulation mode, that this is a Gnosis Safe's own transaction. Every refresh forms it from this (getPendingTransactionGasPayment), and forming it gives the transaction simulationOptions.executeThroughSafe, which tells the simulator to run it through the Safe: the pending decision and the transaction's option relate as a Safe proposal's pending safeTransaction and its stacked safeTransaction do.
	executeThroughSafe: funtypes.Literal(true),
}))

type SimulatedPendingTransactionStatus = funtypes.Static<typeof SimulatedPendingTransactionStatus>
const SimulatedPendingTransactionStatus = funtypes.Union(
	funtypes.ReadonlyObject({
		transactionOrMessageCreationStatus: funtypes.Literal('Simulated'),
		transactionToSimulate: WebsiteCreatedEthereumTransaction,
	}),
	funtypes.ReadonlyObject({
		transactionOrMessageCreationStatus: funtypes.Literal('FailedToSimulate'),
		transactionToSimulate: FailedToCreateWebsiteCreatedEthereumTransaction,
	}),
)

// A simulated pending transaction as the confirmation dialog is sent it, without the run's record.
export type PopupSimulatedPendingTransaction = funtypes.Static<typeof PopupSimulatedPendingTransaction>
const PopupSimulatedPendingTransaction = funtypes.Intersect(
	SimulatedPendingTransactionBase,
	funtypes.ReadonlyObject({ popupVisualisation: ConfirmTransactionTransactionSingleVisualization }),
	SimulatedPendingTransactionStatus,
)

// A simulated pending transaction as background storage keeps it: what the dialog is sent, with the record of the run that produced its visualisation beside it. Confirmations stored by older versions, or by builds that kept the record inside the visualisation, decode without it, as funtypes drops fields its codec does not declare.
type SimulatedPendingTransaction = funtypes.Static<typeof SimulatedPendingTransaction>
const SimulatedPendingTransaction = funtypes.Intersect(
	PopupSimulatedPendingTransaction,
	funtypes.ReadonlyPartial({ confirmationRun: ConfirmationRunRecord }),
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
		transactionToSimulate: WebsiteCreatedEthereumTransaction,
		transactionOrMessageCreationStatus: funtypes.Literal('Simulating')
	})
)

// A pending transaction as background storage keeps it.
export type PendingTransaction = funtypes.Static<typeof PendingTransaction>
export const PendingTransaction = funtypes.Union(CraftingTransactionPendingTransaction, WaitingForSimulationPendingTransaction, SimulatedPendingTransaction)

// A pending transaction as popups are sent it, without its confirmation run's record.
type PopupPendingTransaction = funtypes.Static<typeof PopupPendingTransaction>
const PopupPendingTransaction = funtypes.Union(CraftingTransactionPendingTransaction, WaitingForSimulationPendingTransaction, PopupSimulatedPendingTransaction)

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
	}).And(funtypes.ReadonlyPartial({ safeMessageCoSignSnapshot: SafeMessageCoSignSnapshot })),
	funtypes.Union(
		funtypes.ReadonlyObject({ transactionOrMessageCreationStatus: funtypes.Literal('Simulated'), visualizedPersonalSignRequest: VisualizedPersonalSignRequest }).And(funtypes.ReadonlyPartial({
			// Every entry the visualisation's address lookups resolved, so a dialog refresh after an address-book change can visualise the message again without identifying addresses on chain.
			identifiedAddressBookEntries: funtypes.ReadonlyArray(AddressBookEntry),
		})),
		funtypes.ReadonlyObject({ transactionOrMessageCreationStatus: funtypes.Union(funtypes.Literal('Crafting'), funtypes.Literal('Simulating')) })
	)
)

type PopupPendingSignableMessageBase = funtypes.Static<typeof PopupPendingSignableMessageBase>
const PopupPendingSignableMessageBase = funtypes.ReadonlyObject({
	type: funtypes.Literal('SignableMessage'),
	popupOrTabId: PopupOrTabId,
	originalRequestParameters: SignMessageParams,
	simulationMode: funtypes.Boolean,
	uniqueRequestIdentifier: UniqueRequestIdentifier,
	created: EthereumTimestamp,
	website: Website,
	activeAddress: EthereumAddress,
	approvalStatus: PendingTransactionApprovalStatus,
})

export type PopupPendingSignableMessage = funtypes.Static<typeof PopupPendingSignableMessage>
export const PopupPendingSignableMessage = funtypes.Intersect(
	PopupPendingSignableMessageBase,
	funtypes.Union(
		funtypes.ReadonlyObject({ transactionOrMessageCreationStatus: funtypes.Literal('Simulated'), visualizedPersonalSignRequest: VisualizedPersonalSignRequest }),
		funtypes.ReadonlyObject({ transactionOrMessageCreationStatus: funtypes.Union(funtypes.Literal('Crafting'), funtypes.Literal('Simulating')) })
	)
)

export type PendingTransactionOrSignableMessage = PendingSignableMessage | PendingTransaction
const PendingTransactionOrSignableMessageRuntype: funtypes.Runtype<PendingTransactionOrSignableMessage> = funtypes.Union(PendingSignableMessage, PendingTransaction)
export const PendingTransactionOrSignableMessage: typeof PendingTransactionOrSignableMessageRuntype = PendingTransactionOrSignableMessageRuntype

export type PopupPendingTransactionOrSignableMessage = PopupPendingSignableMessage | PopupPendingTransaction
const PopupPendingTransactionOrSignableMessageRuntype: funtypes.Runtype<PopupPendingTransactionOrSignableMessage> = funtypes.Union(PopupPendingSignableMessage, PopupPendingTransaction)
export const PopupPendingTransactionOrSignableMessage: typeof PopupPendingTransactionOrSignableMessageRuntype = PopupPendingTransactionOrSignableMessageRuntype
