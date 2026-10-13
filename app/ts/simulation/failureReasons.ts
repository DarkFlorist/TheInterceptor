import type { ErrorWithCodeAndOptionalData } from '../types/error.js'
import type { AbiLike } from '../utils/abiRuntime.js'
import { decodeEthereumError, ErrorType } from '../utils/errorDecoding.js'
import { appendPossibleUniswapV3Explanation } from './uniswapV3RevertReasons.js'

// decodeEthereumError stays protocol-agnostic; protocol hints are added here, only to Error(string) reasons, because custom errors and panics already decode to a precise name or description.
export const getFailureReasonForDisplay = (errorAbis: readonly AbiLike[], error: ErrorWithCodeAndOptionalData) => {
	const decodedError = decodeEthereumError(errorAbis, error)
	if (decodedError.type !== ErrorType.RevertError) return decodedError.reason
	return appendPossibleUniswapV3Explanation(decodedError.reason)
}
