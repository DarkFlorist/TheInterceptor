import { METAMASK_ERROR_FAILED_TO_PARSE_REQUEST } from '../utils/constants.js'
import type { SafeSignerErrorDetails } from '../types/safeTypes.js'

export type SafeSignerErrorStatus = {
	readonly status: 'SignerError'
	readonly code: number
	readonly message: string
	readonly safeSignerErrorDetails?: SafeSignerErrorDetails
}

export const createSafeSignerErrorStatus = (
	message: string,
	code = METAMASK_ERROR_FAILED_TO_PARSE_REQUEST,
	safeSignerErrorDetails?: SafeSignerErrorDetails,
): SafeSignerErrorStatus => ({
	status: 'SignerError',
	code,
	message,
	...(safeSignerErrorDetails === undefined ? {} : { safeSignerErrorDetails }),
})
