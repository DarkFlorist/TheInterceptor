import type { ErrorWithCodeAndOptionalData } from '../types/error.js'
import type { AbiLike } from '../utils/abiRuntime.js'
import { decodeEthereumError, ErrorType } from '../utils/errorDecoding.js'
import { appendProtocolRevertReasonHints } from './revertReasonHints.js'

// The one place that decides how a failed transaction's reason is shown, so every caller gets the same protocol hints. Decoded Error(string) revert reasons get them; custom errors and panics already decode to a precise name or description, so they are never annotated.
export const getFailureReasonForDisplay = (errorAbis: readonly AbiLike[], error: ErrorWithCodeAndOptionalData) => {
	const decodedError = decodeEthereumError(errorAbis, error)
	if (decodedError.type !== ErrorType.RevertError) return decodedError.reason
	return appendProtocolRevertReasonHints(decodedError.reason)
}
