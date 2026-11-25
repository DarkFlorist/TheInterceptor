import { createInterceptorInternalError, hasInterceptorInternalErrorCode } from '../utils/caughtErrors.js'

const safeValidationErrorCodes = [
	'safe_contract_validation',
	'safe_message_account_mismatch',
	'safe_owner_validation',
	'safe_signer_selection',
] as const

export type GnosisSafeValidationErrorCode = typeof safeValidationErrorCodes[number]

export function createGnosisSafeValidationError<Code extends GnosisSafeValidationErrorCode>(message: string, code: Code) {
	return createInterceptorInternalError(message, code, 'handled')
}

export function hasGnosisSafeValidationErrorCode<Code extends GnosisSafeValidationErrorCode>(error: unknown, code: Code): error is Error & { readonly interceptorErrorCode: Code } {
	return hasInterceptorInternalErrorCode(error, code)
}
