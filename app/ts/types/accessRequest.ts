import * as funtypes from 'funtypes'
import { PopupOrTabId, Website } from './websiteAccessTypes.js'
import { AddressBookEntry } from './addressBookTypes.js'
import { EthereumAddress, EthereumQuantity, EthereumTimestamp, OptionalEthereumAddress } from './wire-types.js'
import { SignerName } from './signerTypes.js'
import { InterceptedRequest, UniqueRequestIdentifier, WebsiteSocket } from '../utils/requests.js'
import { FailedToCreateWebsiteCreatedEthereumTransaction, NamedTokenId, SignedMessageTransaction, SimulationState, TokenPriceEstimate, VisualizedSimulationState, WebsiteCreatedEthereumTransaction, WebsiteCreatedEthereumTransactionOrFailed } from './visualizer-types.js'
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
	}).And(funtypes.ReadonlyPartial({ safeSignerErrorDetails: SafeSignerErrorDetails })),
)

// How a pending transaction's confirmation forms it, the one record of that decision: prepareSafeTransactionConfirmation makes it once when the confirmation opens, with the data the flow needs, and every refresh reads it back (getPendingTransactionFlowKind) to form the transaction the same way.
// - ordinary: a transaction from the active address, or a raw transaction.
// - simulationModeSafeExecution: in simulation mode, a Gnosis Safe's own transaction. Forming it gives the transaction simulationOptions.executeThroughSafe, which tells the simulator to run it through the Safe.
// - directExecution: a signer's execTransaction call executing a SafeTx of the configured Safe.
// - proposal: a transaction of the configured Safe, proposed as a SafeTx. It is 'created' with its Gnosis Safe transaction, or its creation failed ('creationFailed') and the confirmation keeps that failure.
// - unsupportedSafeRequest: a request the configured Safe can't make through execTransaction (a contract creation), which the confirmation keeps as its request-shape failure.
export type PendingTransactionSafeFlow = funtypes.Static<typeof PendingTransactionSafeFlow>
export const PendingTransactionSafeFlow = funtypes.Union(
	funtypes.ReadonlyObject({ kind: funtypes.Literal('ordinary') }),
	funtypes.ReadonlyObject({ kind: funtypes.Literal('simulationModeSafeExecution') }),
	funtypes.ReadonlyObject({
		kind: funtypes.Literal('directExecution'),
		safeExecutionOriginalRequestParameters: SendTransactionParams,
	}).And(funtypes.ReadonlyPartial({
		safeExecutionSignerAddress: EthereumAddress,
		safeExecutionReviewedSafeState: SafeContractStateSnapshot,
	})),
	funtypes.ReadonlyObject({ kind: funtypes.Literal('proposal'), state: funtypes.Literal('created'), safeTransaction: SafeTransactionSigningRequest }),
	funtypes.ReadonlyObject({ kind: funtypes.Literal('proposal'), state: funtypes.Literal('creationFailed') }),
	funtypes.ReadonlyObject({ kind: funtypes.Literal('unsupportedSafeRequest') }),
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
	// Required, so a pending transaction stored by a version without it does not parse, and the corrupt-storage recovery of pendingTransactionsAndMessages (readPendingTransactionsAndMessagesWithRecovery) clears it instead of a refresh forming it as another kind of transaction.
	safeFlow: PendingTransactionSafeFlow,
})

export type SimulatedPendingTransaction = funtypes.Static<typeof SimulatedPendingTransaction>
export const SimulatedPendingTransaction = funtypes.Intersect(
	SimulatedPendingTransactionBase,
	funtypes.ReadonlyObject({ popupVisualisation: ConfirmTransactionTransactionSingleVisualization }),
	funtypes.Union(
		funtypes.ReadonlyObject({
			transactionOrMessageCreationStatus: funtypes.Literal('Simulated'),
				transactionToSimulate: WebsiteCreatedEthereumTransaction,
		}),
		funtypes.ReadonlyObject({
			transactionOrMessageCreationStatus: funtypes.Literal('FailedToSimulate'),
				transactionToSimulate: FailedToCreateWebsiteCreatedEthereumTransaction,
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
		transactionToSimulate: WebsiteCreatedEthereumTransaction,
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
	}).And(funtypes.ReadonlyPartial({ safeMessageCoSignSnapshot: SafeMessageCoSignSnapshot })),
	funtypes.Union(
		funtypes.ReadonlyObject({ transactionOrMessageCreationStatus: funtypes.Literal('Simulated'), visualizedPersonalSignRequest: VisualizedPersonalSignRequest }),
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

export type PopupPendingTransactionOrSignableMessage = PopupPendingSignableMessage | PendingTransaction
const PopupPendingTransactionOrSignableMessageRuntype: funtypes.Runtype<PopupPendingTransactionOrSignableMessage> = funtypes.Union(PopupPendingSignableMessage, PendingTransaction)
export const PopupPendingTransactionOrSignableMessage: typeof PopupPendingTransactionOrSignableMessageRuntype = PopupPendingTransactionOrSignableMessageRuntype
