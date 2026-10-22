import type { ErrorWithCodeAndOptionalData } from '../types/error.js'
import type { AbiLike } from '../utils/abiRuntime.js'
import { decodeEthereumError, ErrorType } from '../utils/errorDecoding.js'

const keepRevertReasonUnchanged = (revertReason: string) => revertReason

// Callers opt into extra context for decoded Error(string) revert reasons, such as appendProtocolRevertReasonHints, by passing annotateRevertReason. Custom errors and panics already decode to a precise name or description, so they are never annotated.
export const getFailureReasonForDisplay = (errorAbis: readonly AbiLike[], error: ErrorWithCodeAndOptionalData, annotateRevertReason: (revertReason: string) => string = keepRevertReasonUnchanged) => {
	const decodedError = decodeEthereumError(errorAbis, error)
	if (decodedError.type !== ErrorType.RevertError) return decodedError.reason
	return annotateRevertReason(decodedError.reason)
}
