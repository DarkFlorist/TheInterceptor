import type { PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import type { SendTransactionParams } from '../types/JsonRpc-types.js'
import type { SafeMessageCoSignSnapshot, SafeTransactionSigningRequest } from '../types/safeTypes.js'
import type { TransactionGasPayment } from '../types/visualizer-types.js'

type PendingTransaction = Extract<PendingTransactionOrSignableMessage, { readonly type: 'Transaction' }>
type PendingSignableMessage = Extract<PendingTransactionOrSignableMessage, { readonly type: 'SignableMessage' }>

export type DirectSafeExecutionFlow = {
	readonly kind: 'directExecution'
	readonly pending: PendingTransaction & { readonly safeExecutionOriginalRequestParameters: SendTransactionParams }
}

export type SafeMessageCoSignFlow = {
	readonly kind: 'messageCoSign'
	readonly pending: PendingSignableMessage & { readonly safeMessageCoSignSnapshot: SafeMessageCoSignSnapshot }
}

export type SafeProposalFlow = {
	readonly kind: 'proposal'
	readonly pending: PendingTransaction & { readonly safeTransaction: SafeTransactionSigningRequest }
}

export type SafePendingFlow = DirectSafeExecutionFlow | SafeMessageCoSignFlow | SafeProposalFlow

export function getSafeTransactionPendingFlow(pending: PendingTransaction): DirectSafeExecutionFlow | SafeProposalFlow | undefined {
	if (pending.safeExecutionOriginalRequestParameters !== undefined) {
		return {
			kind: 'directExecution',
			pending: { ...pending, safeExecutionOriginalRequestParameters: pending.safeExecutionOriginalRequestParameters },
		}
	}
	if (pending.safeTransaction !== undefined) {
		return {
			kind: 'proposal',
			pending: { ...pending, safeTransaction: pending.safeTransaction },
		}
	}
	return undefined
}

// The kind of transaction a confirmation forms, the one input of its fee mode (getSafeTransactionFlowGasPayment): an ordinary transaction, a Safe's own call that the simulation runs through the Safe in simulation mode, or one of the signing-mode Safe transaction flows.
export type SafeTransactionFlowKind = 'ordinary' | 'simulationModeSafeExecution' | DirectSafeExecutionFlow['kind'] | SafeProposalFlow['kind']

// The fee mode of each kind of transaction confirmation. prepareSafeTransactionConfirmation takes it from here when the confirmation opens and getPendingTransactionGasPayment on every refresh, so both form the transaction the same way.
export function getSafeTransactionFlowGasPayment(flowKind: SafeTransactionFlowKind): TransactionGasPayment {
	switch (flowKind) {
		case 'ordinary': return 'transaction-sender'
		// A direct Safe execution is the signer's own execTransaction call, paid outside the simulation.
		case 'directExecution': return 'external-executor'
		// A Safe proposal, and in simulation mode a Safe's own call, run as the simulated executor's execTransaction call.
		case 'proposal':
		case 'simulationModeSafeExecution': return 'simulated-safe-executor'
	}
}

// The flow kind prepareSafeTransactionConfirmation decided when the confirmation opened, read back from the pending transaction. A simulation-mode Safe execution (executeThroughSafe) is not a SafePendingFlow: those are the signing-mode flows, which sign, propose or execute with the user's signer, while a simulation-mode transaction only runs through the Safe in the simulation.
export function getPendingTransactionFlowKind(pending: PendingTransaction): SafeTransactionFlowKind {
	if (pending.executeThroughSafe === true) return 'simulationModeSafeExecution'
	if (pending.safeProposalCreationFailed === true) return 'proposal'
	return getSafeTransactionPendingFlow(pending)?.kind ?? 'ordinary'
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
		case 'directExecution': return flow.pending.safeExecutionSignerAddress
		case 'messageCoSign': return flow.pending.safeMessageCoSignSnapshot.safeSignerAddress
		case 'proposal': return flow.pending.safeTransaction.safeSignerAddress
	}
}
