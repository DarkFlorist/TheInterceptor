import { METAMASK_ERROR_FAILED_TO_PARSE_REQUEST } from '../utils/constants.js'
import type { GnosisSafeSignerErrorDetails } from '../types/gnosisSafeTypes.js'

export type GnosisSafeSignerErrorStatus = {
	readonly status: 'SignerError'
	readonly code: number
	readonly message: string
	readonly safeSignerErrorDetails?: GnosisSafeSignerErrorDetails
}

export const createGnosisSafeSignerErrorStatus = (
	message: string,
	code = METAMASK_ERROR_FAILED_TO_PARSE_REQUEST,
	safeSignerErrorDetails?: GnosisSafeSignerErrorDetails,
): GnosisSafeSignerErrorStatus => ({
	status: 'SignerError',
	code,
	message,
	...(safeSignerErrorDetails === undefined ? {} : { safeSignerErrorDetails }),
})
