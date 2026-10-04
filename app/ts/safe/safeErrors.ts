import { createInterceptorInternalError, hasInterceptorInternalErrorCode } from '../utils/caughtErrors.js'

const safeValidationErrorCodes = [
	'safe_contract_validation',
	'safe_message_account_mismatch',
	'safe_owner_validation',
	'safe_signer_selection',
] as const

export type SafeValidationErrorCode = typeof safeValidationErrorCodes[number]

export function createSafeValidationError<Code extends SafeValidationErrorCode>(message: string, code: Code) {
	return createInterceptorInternalError(message, code, 'handled')
}

export function hasSafeValidationErrorCode<Code extends SafeValidationErrorCode>(error: unknown, code: Code): error is Error & { readonly interceptorErrorCode: Code } {
	return hasInterceptorInternalErrorCode(error, code)
}
