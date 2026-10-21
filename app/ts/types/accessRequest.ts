import * as funtypes from 'funtypes'
import { PopupOrTabId, Website } from './websiteAccessTypes.js'
import { AddressBookEntry } from './addressBookTypes.js'
import { EthereumAddress, EthereumQuantity, EthereumTimestamp, OptionalEthereumAddress } from './wire-types.js'
import { SignerName } from './signerTypes.js'
import { InterceptedRequest, UniqueRequestIdentifier, WebsiteSocket } from '../utils/requests.js'
import { FailedToCreateWebsiteCreatedEthereumTransaction, NamedTokenId, SignedMessageTransaction, SimulationState, TokenPriceEstimate, VisualizedSimulationState, WebsiteCreatedEthereumTransaction, WebsiteCreatedEthereumTransactionOrFailed } from './visualizer-types.js'
import { VisualizedPersonalSignRequest } from './personal-message-definitions.js'
import { OriginalSendRequestParameters, SendTransactionParams, WalletSendCalls } from './JsonRpc-types.js'
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

type ConfirmationSimulationCommonData = funtypes.Static<typeof ConfirmationSimulationCommonData>
const ConfirmationSimulationCommonData = funtypes.ReadonlyObject({
	activeAddress: EthereumAddress,
	simulationMode: funtypes.Boolean,
	simulationStartedTimestamp: EthereumTimestamp,
	uniqueRequestIdentifier: UniqueRequestIdentifier,
	signerName: SignerName,
}).And(funtypes.ReadonlyPartial({
	// Names one confirmation simulation run of this pending transaction: the run that produced this visualisation. Confirmations stored by older versions have none.
	confirmationRunId: funtypes.Number,
}))

type ConfirmTransactionSimulationBaseData = funtypes.Static<typeof ConfirmTransactionSimulationBaseData>
const ConfirmTransactionSimulationBaseData = funtypes.Intersect(
	ConfirmationSimulationCommonData,
	funtypes.ReadonlyObject({ transactionToSimulate: WebsiteCreatedEthereumTransactionOrFailed }),
)

type VisualizedConfirmationSimulation = funtypes.Static<typeof VisualizedConfirmationSimulation>
const VisualizedConfirmationSimulation = funtypes.ReadonlyObject({
	addressBookEntries: funtypes.ReadonlyArray(AddressBookEntry),
	tokenPriceEstimates: funtypes.ReadonlyArray(TokenPriceEstimate),
	namedTokenIds: funtypes.ReadonlyArray(NamedTokenId),
	simulationState: SimulationState,
	activeAddress: OptionalEthereumAddress,
	visualizedSimulationState: VisualizedSimulationState
})

type FailedConfirmationSimulation = funtypes.Static<typeof FailedConfirmationSimulation>
const FailedConfirmationSimulation = funtypes.ReadonlyObject({
	error: DecodedError,
	simulationState: funtypes.ReadonlyObject({
		blockNumber: EthereumQuantity,
		simulationConductedTimestamp: EthereumTimestamp,
	})
})

type ConfirmTransactionDialogState = funtypes.Static<typeof ConfirmTransactionDialogState>
const ConfirmTransactionDialogState = funtypes.Intersect(ConfirmTransactionSimulationBaseData, VisualizedConfirmationSimulation)

type ConfirmTransactionSimulationStateChanged = funtypes.Static<typeof ConfirmTransactionSimulationStateChanged>
const ConfirmTransactionSimulationStateChanged = funtypes.ReadonlyObject({
	statusCode: funtypes.Literal('success'),
	data: ConfirmTransactionDialogState
})

type ConfirmTransactionSimulationFailed = funtypes.Static<typeof ConfirmTransactionSimulationFailed>
const ConfirmTransactionSimulationFailed = funtypes.ReadonlyObject({
	statusCode: funtypes.Literal('failed'),
	data: funtypes.Intersect(ConfirmTransactionSimulationBaseData, FailedConfirmationSimulation)
}).asReadonly()

export type ConfirmTransactionTransactionSingleVisualization = funtypes.Static<typeof ConfirmTransactionTransactionSingleVisualization>
export const ConfirmTransactionTransactionSingleVisualization = funtypes.Union(ConfirmTransactionSimulationFailed, ConfirmTransactionSimulationStateChanged)

// A batch is visualized as one simulation in which every successfully prepared call is appended, in order, on top of the current simulation stack.
export type ConfirmTransactionBatchVisualization = funtypes.Static<typeof ConfirmTransactionBatchVisualization>
export const ConfirmTransactionBatchVisualization = funtypes.Union(
	funtypes.ReadonlyObject({
		statusCode: funtypes.Literal('success'),
		data: funtypes.Intersect(ConfirmationSimulationCommonData, VisualizedConfirmationSimulation),
	}),
	funtypes.ReadonlyObject({
		statusCode: funtypes.Literal('failed'),
		data: funtypes.Intersect(ConfirmationSimulationCommonData, FailedConfirmationSimulation),
	}),
)

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
}))

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

// Captured when wallet_sendCalls is admitted and re-checked on approval, so a batch is only ever approved for the website, account and network it was simulated for.
export type WalletSendCallsBinding = funtypes.Static<typeof WalletSendCallsBinding>
export const WalletSendCallsBinding = funtypes.ReadonlyObject({
	websiteOrigin: funtypes.String,
	account: EthereumAddress,
	chainId: EthereumQuantity,
})

type PendingTransactionBatchBase = funtypes.Static<typeof PendingTransactionBatchBase>
const PendingTransactionBatchBase = funtypes.ReadonlyObject({
	type: funtypes.Literal('TransactionBatch'),
	popupOrTabId: PopupOrTabId,
	// The canonical request rebuilt from the validated calls. The same calls are simulated, shown, approved and added to the simulation stack.
	originalRequestParameters: WalletSendCalls,
	uniqueRequestIdentifier: UniqueRequestIdentifier,
	// Signing mode refuses wallet_sendCalls (see getSigningModeWalletCallsReply), so every batch belongs to simulation mode.
	simulationMode: funtypes.Literal(true),
	activeAddress: EthereumAddress,
	created: EthereumTimestamp,
	website: Website,
	approvalStatus: PendingTransactionApprovalStatus,
	binding: WalletSendCallsBinding,
	// Returned to the website when the batch is added to the simulation stack.
	batchId: funtypes.String,
})

export type PendingTransactionBatch = funtypes.Static<typeof PendingTransactionBatch>
export const PendingTransactionBatch = funtypes.Intersect(
	PendingTransactionBatchBase,
	funtypes.Union(
		funtypes.ReadonlyObject({ transactionOrMessageCreationStatus: funtypes.Literal('Crafting') }),
		funtypes.ReadonlyObject({
			// Simulated when every call could be prepared as a transaction, FailedToSimulate otherwise.
			transactionOrMessageCreationStatus: funtypes.Union(funtypes.Literal('Simulated'), funtypes.Literal('FailedToSimulate')),
			transactionsToSimulate: funtypes.ReadonlyArray(WebsiteCreatedEthereumTransactionOrFailed),
			popupVisualisation: ConfirmTransactionBatchVisualization,
			// Identifies everything the preview was simulated from: the stack and the settings, time manipulation and rich addresses its input depends on. Approval refuses the batch once any of them changed (see getStackSimulationContextFingerprint).
			simulatedContextFingerprint: funtypes.String,
		}),
	),
)

// One wallet_sendCalls batch id that a website uses, with the calls that approving its batch adds to the simulation stack (see walletSendCallsBatchIds.ts for when records are added and removed).
export type WalletSendCallsBatchIdRecord = funtypes.Static<typeof WalletSendCallsBatchIdRecord>
export const WalletSendCallsBatchIdRecord = funtypes.ReadonlyObject({
	websiteOrigin: funtypes.String,
	batchId: funtypes.String,
	transactionIdentifiers: funtypes.ReadonlyArray(EthereumQuantity),
})

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

export type PendingTransactionOrSignableMessage = PendingSignableMessage | PendingTransaction | PendingTransactionBatch
// The confirmations that the single-transaction, message and Gnosis Safe flows handle: every kind except wallet_sendCalls batches, which walletSendCallsConfirmation.ts confirms.
export type PendingTransactionOrSignableMessageExceptBatch = Exclude<PendingTransactionOrSignableMessage, { readonly type: 'TransactionBatch' }>
const PendingTransactionOrSignableMessageRuntype: funtypes.Runtype<PendingTransactionOrSignableMessage> = funtypes.Union(PendingSignableMessage, PendingTransaction, PendingTransactionBatch)
export const PendingTransactionOrSignableMessage: typeof PendingTransactionOrSignableMessageRuntype = PendingTransactionOrSignableMessageRuntype

export type PopupPendingTransactionOrSignableMessage = PopupPendingSignableMessage | PendingTransaction | PendingTransactionBatch
const PopupPendingTransactionOrSignableMessageRuntype: funtypes.Runtype<PopupPendingTransactionOrSignableMessage> = funtypes.Union(PopupPendingSignableMessage, PendingTransaction, PendingTransactionBatch)
export const PopupPendingTransactionOrSignableMessage: typeof PopupPendingTransactionOrSignableMessageRuntype = PopupPendingTransactionOrSignableMessageRuntype
