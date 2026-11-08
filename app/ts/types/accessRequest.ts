import * as funtypes from 'funtypes'
import { PopupOrTabId, Website } from './websiteAccessTypes.js'
import { AddressBookEntry } from './addressBookTypes.js'
import { EthereumAddress, EthereumQuantity, EthereumTimestamp, LiteralConverterParserFactory, OptionalEthereumAddress } from './wire-types.js'
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

// Confirmations stored by versions that did not record the requested network or the simulation run lack these fields. They are decoded here, the only place that knows that shape, so every constructed confirmation has to provide both fields.
const decodedFromMissingFieldAs = <StandIn>(standIn: StandIn) => funtypes.Literal(undefined).withParser(LiteralConverterParserFactory<undefined, StandIn>(undefined, standIn))

// The network the website requested the transaction on. Its preview is only refreshed and approved on this network. A confirmation stored without it decodes as 'unknown', which equals no chain id, so it is never refreshed or approved.
const RequestedChainId = funtypes.Union(EthereumQuantity, funtypes.Literal('unknown'), decodedFromMissingFieldAs<'unknown'>('unknown'))

// Identifies the confirmation simulation run that produced a visualisation: the random id of the background lifetime that ran it and the run's place among that lifetime's runs. A visualisation stored without one decodes as a run of no lifetime, which no run's lifetime matches.
export type ConfirmationRunId = funtypes.Static<typeof ConfirmationRunIdWithoutStandIn>
const ConfirmationRunIdWithoutStandIn = funtypes.ReadonlyObject({ lifetime: funtypes.String, sequence: funtypes.Number })
export const CONFIRMATION_RUN_OF_NO_LIFETIME: ConfirmationRunId = { lifetime: '', sequence: 0 }
const ConfirmationRunIdCodec = funtypes.Union(ConfirmationRunIdWithoutStandIn, decodedFromMissingFieldAs(CONFIRMATION_RUN_OF_NO_LIFETIME))

type ConfirmTransactionSimulationBaseData = funtypes.Static<typeof ConfirmTransactionSimulationBaseData>
const ConfirmTransactionSimulationBaseData = funtypes.ReadonlyObject({
	activeAddress: EthereumAddress,
	simulationMode: funtypes.Boolean,
	simulationStartedTimestamp: EthereumTimestamp,
	uniqueRequestIdentifier: UniqueRequestIdentifier,
	transactionToSimulate: WebsiteCreatedEthereumTransactionOrFailed,
	signerName: SignerName,
})

// Background bookkeeping that is stored with a visualisation but left out of what the windows receive, which have no use for it.
const ConfirmationRunOfVisualisation = funtypes.ReadonlyObject({ confirmationRunId: ConfirmationRunIdCodec })

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

export type ConfirmTransactionTransactionSingleVisualization = funtypes.Static<typeof ConfirmTransactionTransactionSingleVisualization>
export const ConfirmTransactionTransactionSingleVisualization = funtypes.Union(
	funtypes.ReadonlyObject({ statusCode: funtypes.Literal('failed'), data: funtypes.Intersect(ConfirmTransactionSimulationFailedData, ConfirmationRunOfVisualisation) }).asReadonly(),
	funtypes.ReadonlyObject({ statusCode: funtypes.Literal('success'), data: funtypes.Intersect(ConfirmTransactionDialogState, ConfirmationRunOfVisualisation) }),
)

export type PopupConfirmTransactionTransactionSingleVisualization = funtypes.Static<typeof PopupConfirmTransactionTransactionSingleVisualization>
export const PopupConfirmTransactionTransactionSingleVisualization = funtypes.Union(
	funtypes.ReadonlyObject({ statusCode: funtypes.Literal('failed'), data: ConfirmTransactionSimulationFailedData }).asReadonly(),
	funtypes.ReadonlyObject({ statusCode: funtypes.Literal('success'), data: ConfirmTransactionDialogState }),
)

type PendingTransactionApprovalStatus = funtypes.Static<typeof PendingTransactionApprovalStatus>
const PendingTransactionApprovalStatus = funtypes.Union(
	funtypes.ReadonlyObject({ status: funtypes.Union(funtypes.Literal('WaitingForUser'), funtypes.Literal('WaitingForSigner')) }),
	funtypes.ReadonlyObject({
		status: funtypes.Union(funtypes.Literal('SignerError')),
		code: funtypes.Number,
		message: funtypes.String,
	}).And(funtypes.ReadonlyPartial({ safeSignerErrorDetails: SafeSignerErrorDetails })),
	// The Interceptor's own refusal under the requested-network check, kept only while that check still refuses, unlike a SignerError, which the wallet or the signing flow reported and which stays until the next approval. Only transactionNetwork.ts writes it.
	funtypes.ReadonlyObject({ status: funtypes.Literal('NetworkRefusal'), message: funtypes.String }),
)

// What the windows receive of a pending transaction. The stored form adds requestedChainId, which only the background uses.
const PopupPendingTransactionBase = funtypes.ReadonlyObject({
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

const SimulatedPendingTransactionBase = funtypes.Intersect(PopupPendingTransactionBase, funtypes.ReadonlyObject({ requestedChainId: RequestedChainId }))

// The stored and the window forms of a pending transaction differ only in the bookkeeping their base and visualisation carry, so both are built from one definition.
function createPendingTransactionRuntypes<Base, Visualisation>(base: funtypes.Runtype<Base>, visualisation: funtypes.Runtype<Visualisation>) {
	const simulated = funtypes.Intersect(
		base,
		funtypes.ReadonlyObject({ popupVisualisation: visualisation }),
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
	const crafting = funtypes.Intersect(base, funtypes.ReadonlyObject({ transactionOrMessageCreationStatus: funtypes.Literal('Crafting') }))
	const simulating = funtypes.Intersect(base, funtypes.ReadonlyObject({ transactionToSimulate: WebsiteCreatedEthereumTransaction, transactionOrMessageCreationStatus: funtypes.Literal('Simulating') }))
	return { simulated, pending: funtypes.Union(crafting, simulating, simulated) }
}

const storedPendingTransaction = createPendingTransactionRuntypes(SimulatedPendingTransactionBase, ConfirmTransactionTransactionSingleVisualization)
const popupPendingTransaction = createPendingTransactionRuntypes(PopupPendingTransactionBase, PopupConfirmTransactionTransactionSingleVisualization)

export type SimulatedPendingTransaction = funtypes.Static<typeof SimulatedPendingTransaction>
export const SimulatedPendingTransaction = storedPendingTransaction.simulated

export type PendingTransaction = funtypes.Static<typeof PendingTransaction>
export const PendingTransaction = storedPendingTransaction.pending

export type PopupSimulatedPendingTransaction = funtypes.Static<typeof PopupSimulatedPendingTransaction>
export const PopupSimulatedPendingTransaction = popupPendingTransaction.simulated

export type PopupPendingTransaction = funtypes.Static<typeof PopupPendingTransaction>
export const PopupPendingTransaction = popupPendingTransaction.pending

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

export type PopupPendingTransactionOrSignableMessage = PopupPendingSignableMessage | PopupPendingTransaction
const PopupPendingTransactionOrSignableMessageRuntype: funtypes.Runtype<PopupPendingTransactionOrSignableMessage> = funtypes.Union(PopupPendingSignableMessage, PopupPendingTransaction)
export const PopupPendingTransactionOrSignableMessage: typeof PopupPendingTransactionOrSignableMessageRuntype = PopupPendingTransactionOrSignableMessageRuntype
