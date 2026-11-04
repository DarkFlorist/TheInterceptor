import type { PendingTransactionOrSignableMessage, PendingTransactionSafeFlow } from '../types/accessRequest.js'
import type { SafeMessageCoSignSnapshot, SafeTransactionSigningRequest } from '../types/safeTypes.js'
import type { TransactionGasPayment } from '../types/visualizer-types.js'

type PendingTransaction = Extract<PendingTransactionOrSignableMessage, { readonly type: 'Transaction' }>
type PendingSignableMessage = Extract<PendingTransactionOrSignableMessage, { readonly type: 'SignableMessage' }>
type DirectSafeExecutionSafeFlow = Extract<PendingTransactionSafeFlow, { readonly kind: 'directExecution' }>
type CreatedSafeProposalSafeFlow = Extract<PendingTransactionSafeFlow, { readonly kind: 'proposal', readonly state: 'created' }>

export type DirectSafeExecutionFlow = {
	readonly kind: 'directExecution'
	readonly pending: PendingTransaction & { readonly safeFlow: DirectSafeExecutionSafeFlow }
}

export type SafeMessageCoSignFlow = {
	readonly kind: 'messageCoSign'
	readonly pending: PendingSignableMessage & { readonly safeMessageCoSignSnapshot: SafeMessageCoSignSnapshot }
}

export type SafeProposalFlow = {
	readonly kind: 'proposal'
	readonly pending: PendingTransaction & { readonly safeFlow: CreatedSafeProposalSafeFlow }
}

export type SafePendingFlow = DirectSafeExecutionFlow | SafeMessageCoSignFlow | SafeProposalFlow

export const createCreatedSafeProposalSafeFlow = (safeTransaction: SafeTransactionSigningRequest): CreatedSafeProposalSafeFlow => ({ kind: 'proposal', state: 'created', safeTransaction })

// The Gnosis Safe transaction of a created Safe proposal, the one flow that has one.
export const getCreatedSafeProposal = (safeFlow: PendingTransactionSafeFlow) => safeFlow.kind === 'proposal' && safeFlow.state === 'created' ? safeFlow.safeTransaction : undefined

// The signing-mode flows, which sign, propose or execute with the user's signer. A simulation-mode Safe execution is not one: it only runs through the Safe in the simulation. Neither is a Safe proposal that was not created, which has nothing to sign.
export function getSafeTransactionPendingFlow(pending: PendingTransaction): DirectSafeExecutionFlow | SafeProposalFlow | undefined {
	const safeFlow = pending.safeFlow
	if (safeFlow.kind === 'directExecution') return { kind: 'directExecution', pending: { ...pending, safeFlow } }
	if (safeFlow.kind === 'proposal' && safeFlow.state === 'created') return { kind: 'proposal', pending: { ...pending, safeFlow } }
	return undefined
}

// The kind of transaction a confirmation forms, the one input of its fee mode (getSafeTransactionFlowGasPayment).
export type SafeTransactionFlowKind = PendingTransactionSafeFlow['kind']

// The fee mode of each kind of transaction confirmation. prepareSafeTransactionConfirmation takes it from here when the confirmation opens and getPendingTransactionGasPayment on every refresh, so both form the transaction the same way.
export function getSafeTransactionFlowGasPayment(flowKind: SafeTransactionFlowKind): TransactionGasPayment {
	switch (flowKind) {
		case 'ordinary': return 'transaction-sender'
		// A direct Safe execution is the signer's own execTransaction call, paid outside the simulation.
		case 'directExecution': return 'external-executor'
		// Never formed: the confirmation shows its request-shape rejection as the preparation message. Like every Safe transaction, it would not be paid by the Safe.
		case 'unsupportedSafeRequest': return 'external-executor'
		// A Safe proposal, and in simulation mode a Safe's own call, run as the simulated executor's execTransaction call.
		case 'proposal':
		case 'simulationModeSafeExecution': return 'simulated-safe-executor'
	}
}

// The flow kind prepareSafeTransactionConfirmation decided when the confirmation opened, read back from the pending transaction.
export const getPendingTransactionFlowKind = (pending: PendingTransaction): SafeTransactionFlowKind => pending.safeFlow.kind

// A confirmation whose Gnosis Safe transaction could not be made keeps its failure on refresh: forming the request again would not make the Safe transaction, and could only show it as an ordinary transaction from the Safe.
export function keepsSafeFailureOnRefresh(pending: PendingTransaction) {
	const safeFlow = pending.safeFlow
	switch (safeFlow.kind) {
		case 'ordinary':
		case 'simulationModeSafeExecution':
		case 'directExecution': return false
		case 'unsupportedSafeRequest': return true
		case 'proposal': return safeFlow.state === 'creationFailed'
	}
}

export function getPendingTransactionGasPayment(pending: PendingTransaction): TransactionGasPayment {
	return getSafeTransactionFlowGasPayment(getPendingTransactionFlowKind(pending))
}

export function getSafePendingFlow(pending: PendingTransactionOrSignableMessage): SafePendingFlow | undefined {
	if (pending.type === 'Transaction') return getSafeTransactionPendingFlow(pending)
	if (pending.safeMessageCoSignSnapshot === undefined) return undefined
	return {
		kind: 'messageCoSign',
		pending: { ...pending, safeMessageCoSignSnapshot: pending.safeMessageCoSignSnapshot },
	}
}

export function getSafeFlowSignerAddress(flow: SafePendingFlow) {
	switch (flow.kind) {
		case 'directExecution': return flow.pending.safeFlow.safeExecutionSignerAddress
		case 'messageCoSign': return flow.pending.safeMessageCoSignSnapshot.safeSignerAddress
		case 'proposal': return flow.pending.safeFlow.safeTransaction.safeSignerAddress
	}
}
