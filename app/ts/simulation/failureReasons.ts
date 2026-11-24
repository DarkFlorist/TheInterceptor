import type { ErrorWithOptionalExplanation } from '../types/error.js'
import { isInsufficientBalanceMessage } from '../utils/insufficientBalance.js'
import type { AbiLike } from '../utils/abiRuntime.js'
import { decodeEthereumError, ErrorType } from '../utils/errorDecoding.js'
import { explainUniswapV3RevertReason } from './uniswapV3RevertReasons.js'

// The text older versions stored as the message of a Gnosis Safe's GS013. This is a record of that stored text, not the Safe layer's current wording, so it must not change when that wording does.
const LEGACY_SAFE_CALL_REVERTED_MESSAGE = 'The Gnosis Safe\'s call reverted (GS013). The Safe does not pass on the call\'s own revert reason.'

// Failures stored before the explanation fields existed have the explanation as their message and no field saying so. Their text is the only evidence left, so these are the only checks that read it, and no failure formed by this version depends on them.
const isLegacyExplanationMessage = (message: string) => message === LEGACY_SAFE_CALL_REVERTED_MESSAGE || isInsufficientBalanceMessage(message)

// An optional Interceptor diagnosis takes precedence over decoding raw error data (for example the Safe's bare GS013). Errors without a diagnosis are decoded normally.
export const getInterceptorErrorExplanation = (error: ErrorWithOptionalExplanation) => {
	if (error.insufficientBalanceMessage !== undefined) return error.insufficientBalanceMessage
	if (error.safeCallRevertedMessage !== undefined) return error.safeCallRevertedMessage
	return isLegacyExplanationMessage(error.message) ? error.message : undefined
}

// The one display policy for both RPC and transaction-creation failures. Deliberate Interceptor explanations take precedence over decoding, and all other failures get the same protocol hints. Decoded Error(string) revert reasons get them; custom errors and panics already decode to a precise name or description, so they are never annotated.
export const getFailureReasonForDisplay = (errorAbis: readonly AbiLike[], error: ErrorWithOptionalExplanation) => {
	const diagnosis = getInterceptorErrorExplanation(error)
	if (diagnosis !== undefined) return diagnosis
	const decodedError = decodeEthereumError(errorAbis, error)
	if (decodedError.type !== ErrorType.RevertError) return decodedError.reason
	const explanation = explainUniswapV3RevertReason(decodedError.reason)
	return explanation === undefined ? decodedError.reason : `${ decodedError.reason } - possible Uniswap V3 error: ${ explanation }`
}
