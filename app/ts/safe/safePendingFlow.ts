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

// The fee mode prepareSafeTransactionConfirmation decided when the confirmation opened, read back from the pending transaction so every refresh forms the transaction the same way.
export function getPendingTransactionGasPayment(pending: PendingTransaction): TransactionGasPayment {
	if (pending.executeThroughSafe === true) return 'simulated-safe-executor'
	switch (getSafeTransactionPendingFlow(pending)?.kind) {
		case undefined: return 'transaction-sender'
		case 'proposal': return 'simulated-safe-executor'
		case 'directExecution': return 'external-executor'
	}
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
