import type { TransactionCreationError } from '../types/error.js'
import { isInsufficientBalanceMessage } from '../utils/insufficientBalance.js'
import type { AbiLike } from '../utils/abiRuntime.js'
import { decodeEthereumError, ErrorType } from '../utils/errorDecoding.js'
import { appendProtocolRevertReasonHints } from './revertReasonHints.js'

// The text older versions stored as the message of a Gnosis Safe's GS013. This is a record of that stored text, not the Safe layer's current wording, so it must not change when that wording does.
const LEGACY_SAFE_CALL_REVERTED_MESSAGE = 'The Gnosis Safe\'s call reverted (GS013). The Safe does not pass on the call\'s own revert reason.'

// Failures stored before the explanation fields existed have the explanation as their message and no field saying so. Their text is the only evidence left, so these are the only checks that read it, and no failure formed by this version depends on them.
const isLegacyExplanationMessage = (message: string) => message === LEGACY_SAFE_CALL_REVERTED_MESSAGE || isInsufficientBalanceMessage(message)

// Explanations the Interceptor itself wrote for a transaction creation failure. Each keeps revert data that decodes to a less helpful reason (the Safe's call keeps the bare GS013), so the explanation is shown instead of the decoded reason.
export const getInterceptorTransactionCreationExplanation = (error: TransactionCreationError) => {
	if (error.insufficientBalanceMessage !== undefined) return error.insufficientBalanceMessage
	if (error.safeCallRevertedMessage !== undefined) return error.safeCallRevertedMessage
	return isLegacyExplanationMessage(error.message) ? error.message : undefined
}

// The one display policy for both RPC and transaction-creation failures. Deliberate Interceptor explanations take precedence over decoding, and all other failures get the same protocol hints. Decoded Error(string) revert reasons get them; custom errors and panics already decode to a precise name or description, so they are never annotated.
export const getFailureReasonForDisplay = (errorAbis: readonly AbiLike[], error: TransactionCreationError) => {
	const explanation = getInterceptorTransactionCreationExplanation(error)
	if (explanation !== undefined) return explanation
	const decodedError = decodeEthereumError(errorAbis, error)
	if (decodedError.type !== ErrorType.RevertError) return decodedError.reason
	return appendProtocolRevertReasonHints(decodedError.reason)
}
