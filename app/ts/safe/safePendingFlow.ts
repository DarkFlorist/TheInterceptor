import type { PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import type { SendTransactionParams } from '../types/JsonRpc-types.js'
import type { SafeMessageCoSignSnapshot, SafeTransactionSigningRequest } from '../types/safeTypes.js'

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
