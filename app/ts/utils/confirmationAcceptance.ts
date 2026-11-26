import type { PendingTransactionOrSignableMessage, PopupPendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import { isPendingTransactionGasLimitCurrent } from './pendingTransactionSimulation.js'
import { getSendAnywayOverrideReason, isRejectOnlyTransaction } from './sendAnywayConsent.js'

export type ConfirmationAcceptance = { readonly reviewedResultId: string, readonly forceSend: boolean }
export type ConfirmationAcceptanceRefusal = 'waitingForSigner' | 'notSimulated' | 'reviewChanged' | 'rejectOnly' | 'gasLimitChanged' | 'sendAnywayRequired'
type ReviewedPending = (PendingTransactionOrSignableMessage | PopupPendingTransactionOrSignableMessage) & { readonly reviewedResultId: string }

// Background admission and popup explanations apply one policy to their respective stored/stamped copies. The background computes the stamp from storage; the popup uses the background's stamp unchanged.
export function getConfirmationAcceptanceRefusal(pending: ReviewedPending, accept: ConfirmationAcceptance): ConfirmationAcceptanceRefusal | undefined {
	if (pending.approvalStatus.status === 'WaitingForSigner') return 'waitingForSigner'
	if (pending.transactionOrMessageCreationStatus !== 'Simulated') return 'notSimulated'
	if (pending.reviewedResultId !== accept.reviewedResultId) return 'reviewChanged'
	if (isRejectOnlyTransaction(pending)) return 'rejectOnly'
	if (!accept.forceSend && !isPendingTransactionGasLimitCurrent(pending)) return 'gasLimitChanged'
	if (!accept.forceSend && getSendAnywayOverrideReason(pending) !== undefined) return 'sendAnywayRequired'
	return undefined
}
