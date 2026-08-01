import { METAMASK_ERROR_FAILED_TO_PARSE_REQUEST } from '../utils/constants.js'

export type SafeSignerErrorStatus = {
	readonly status: 'SignerError'
	readonly code: number
	readonly message: string
}

export const createSafeSignerErrorStatus = (
	message: string,
	code = METAMASK_ERROR_FAILED_TO_PARSE_REQUEST,
): SafeSignerErrorStatus => ({
	status: 'SignerError',
	code,
	message,
})
