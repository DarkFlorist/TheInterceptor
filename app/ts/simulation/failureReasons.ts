import type { ErrorWithCodeAndOptionalData } from '../types/error.js'
import type { AbiLike } from '../utils/abiRuntime.js'
import { decodeEthereumError, ErrorType } from '../utils/errorDecoding.js'
import { explainUniswapV3RevertReason } from './uniswapV3RevertReasons.js'

// Revert strings can bubble through routers and forks, and unrelated contracts can use the same codes. Keep the original reason and label the explanation as a possibility. Custom errors and panics are already decoded precisely.
export const getFailureReasonForDisplay = (errorAbis: readonly AbiLike[], error: ErrorWithCodeAndOptionalData) => {
	const decoded = decodeEthereumError(errorAbis, error)
	if (decoded.type !== ErrorType.RevertError) return decoded.reason
	const explanation = explainUniswapV3RevertReason(decoded.reason)
	return explanation === undefined ? decoded.reason : `${ decoded.reason } - possible Uniswap V3 error: ${ explanation }`
}
