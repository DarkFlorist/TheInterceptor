import { SAFE_CALL_REVERTED_MESSAGE } from '../safe/safeExecutionFailure.js'
import type { TransactionCreationError } from '../types/error.js'
import type { AbiLike } from '../utils/abiRuntime.js'
import { isInsufficientBalanceMessage } from '../utils/insufficientBalance.js'
import { getFailureReasonForDisplay } from './failureReasons.js'
import { appendProtocolRevertReasonHints } from './revertReasonHints.js'

// Explanations the Interceptor itself wrote for a transaction creation failure. Each keeps revert data that decodes to a less helpful reason (the Safe's call keeps the bare GS013), so the explanation is shown instead of the decoded reason:
// - insufficientBalanceMessage, the balance shortfall with its amounts;
// - the Safe layer's GS013 explanation, which estimateSafeExecutionGas writes as the message;
// - the balance shortfall that older versions stored as the message before insufficientBalanceMessage existed.
export const getInterceptorTransactionCreationExplanation = (error: TransactionCreationError) => {
	if (error.insufficientBalanceMessage !== undefined) return error.insufficientBalanceMessage
	if (error.message === SAFE_CALL_REVERTED_MESSAGE || isInsufficientBalanceMessage(error.message)) return error.message
	return undefined
}

// The only derivation of the reason shown when a transaction fails to be created: an Interceptor explanation overrides the decoded revert reason.
export const getTransactionCreationFailureReason = (errorAbis: readonly AbiLike[], error: TransactionCreationError) => getInterceptorTransactionCreationExplanation(error) ?? getFailureReasonForDisplay(errorAbis, error, appendProtocolRevertReasonHints)
