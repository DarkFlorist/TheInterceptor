import type { ErrorWithCodeAndOptionalData } from '../types/error.js'
import type { AbiLike } from '../utils/abiRuntime.js'
import { decodeEthereumError, ErrorType } from '../utils/errorDecoding.js'

// annotateRevertReason is required so every caller states whether decoded Error(string) revert reasons get extra context, such as appendProtocolRevertReasonHints. Custom errors and panics already decode to a precise name or description, so they are never annotated.
export const getFailureReasonForDisplay = (errorAbis: readonly AbiLike[], error: ErrorWithCodeAndOptionalData, annotateRevertReason: (revertReason: string) => string) => {
	const decodedError = decodeEthereumError(errorAbis, error)
	if (decodedError.type !== ErrorType.RevertError) return decodedError.reason
	return annotateRevertReason(decodedError.reason)
}
