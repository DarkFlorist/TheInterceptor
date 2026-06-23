import { sendPopupMessageToOpenWindowsWithoutUnexpectedErrorReport } from '../background/backgroundUtils.js'
import { appendInterceptorErrorDiagnostic, setLatestUnexpectedError } from '../background/storageVariables.js'
import { InterceptorError, type JsonRpcErrorResponse } from '../types/JsonRpc-types.js'
import type { InterceptorErrorCategory, InterceptorErrorDiagnostic, InterceptorErrorSeverity } from '../types/errorDiagnostics.js'
import { getErrorMessage, getInterceptorInternalErrorCode, isBrowserFetchTransportError } from './caughtErrors.js'
import { NEW_BLOCK_ABORT } from './constants.js'
export { createInterceptorInternalError, getErrorMessage } from './caughtErrors.js'

export const GENERIC_UNEXPECTED_ERROR_MESSAGE = 'An internal Interceptor error occurred. Please see The Interceptor console for technical details.'

type ErrorReportMetadata = {
	source?: string
	code?: string
	debugId?: string
	displayMessage?: string
	category?: InterceptorErrorCategory
	severity?: InterceptorErrorSeverity
	details?: unknown
	userVisible?: boolean
	suppressExpectedInfrastructure?: boolean
}

type LocalRecoveryMetadata = {
	source?: string
	code: string
	message?: string
	details?: unknown
	category?: InterceptorErrorCategory
}

type ErrorPolicyEntry = {
	category: InterceptorErrorCategory
	severity: InterceptorErrorSeverity
	userVisible: boolean
}

// Reporting policy:
// - expected_infrastructure is benign network/block churn and is suppressed at unexpected-error boundaries.
// - external_service is a third-party lookup failure where Interceptor can keep operating.
// - local_recovery is an internal fallback path that should not surface a popup error.
// - unexpected is a user-visible internal failure that should be persisted and broadcast.
export const ERROR_REPORTING_POLICY = {
	expectedInfrastructure: { category: 'expected_infrastructure', severity: 'info', userVisible: false },
	externalService: { category: 'external_service', severity: 'warning', userVisible: false },
	localRecovery: { category: 'local_recovery', severity: 'warning', userVisible: false },
	unexpected: { category: 'unexpected', severity: 'error', userVisible: true },
} satisfies Record<string, ErrorPolicyEntry>

type InterceptorErrorReport = InterceptorErrorDiagnostic

export class ErrorWithData extends Error {
	public constructor(message: string, public data: unknown) {
		super(message)
		Object.setPrototypeOf(this, ErrorWithData.prototype)
	}
}

export class JsonRpcResponseError extends Error {
	public readonly id: string | number
	public readonly code: number
	public readonly data: string | undefined
	public constructor(jsonRpcResponse: JsonRpcErrorResponse) {
		super(jsonRpcResponse.error.message)
		this.code = jsonRpcResponse.error.code
		this.id = jsonRpcResponse.id
		this.data = jsonRpcResponse.error.data
		Object.setPrototypeOf(this, JsonRpcResponseError.prototype)
	}
	public serialize() {
		return {
			jsonrpc: '2.0' as const,
			id: this.id,
			error: {
				message: this.message,
				code: this.code,
				...(this.data !== undefined ? { data: this.data } : {}),
			},
		}
	}
}

export function isFailedToFetchError(error: unknown) {
	const code = getInterceptorInternalErrorCode(error)
	if (code === 'fetch_timeout' || code === 'fetch_aborted' || code === 'fetch_transport_failed') return true
	return isBrowserFetchTransportError(error)
}

export const isNewBlockAbort = (error: unknown) => getErrorMessage(error) === NEW_BLOCK_ABORT

export const isWrappedNewBlockAbort = (error: unknown) => {
	const message = getErrorMessage(error)
	return message !== undefined && message !== NEW_BLOCK_ABORT && message.includes(NEW_BLOCK_ABORT)
}

export type CaughtErrorClassification = 'newBlockAbort' | 'failedToFetch' | 'unexpected'

export function classifyCaughtError(error: unknown): CaughtErrorClassification {
	if (isNewBlockAbort(error)) return 'newBlockAbort'
	if (isFailedToFetchError(error)) return 'failedToFetch'
	return 'unexpected'
}

export const isExpectedInfrastructureError = (error: unknown) => classifyCaughtError(error) !== 'unexpected'

function getForwardedDiagnostics(error: unknown): string | undefined {
	const maybeInterceptorError = InterceptorError.safeParse(error)
	if (!maybeInterceptorError.success) return undefined
	return maybeInterceptorError.value.params[0]
}

function normalizeUnexpectedError(error: unknown) {
	if (typeof error === 'object' && error !== null && 'message' in error && error.message !== undefined && typeof error.message === 'string') {
		return { message: error.message }
	}
	return { message: GENERIC_UNEXPECTED_ERROR_MESSAGE }
}

const MAX_DIAGNOSTIC_DETAILS_LENGTH = 2000

function truncateDiagnosticDetails(details: string) {
	if (details.length <= MAX_DIAGNOSTIC_DETAILS_LENGTH) return details
	return `${ details.slice(0, MAX_DIAGNOSTIC_DETAILS_LENGTH) }...`
}

function stringifyDiagnosticDetails(details: unknown): string | undefined {
	if (details === undefined) return undefined
	if (typeof details === 'string') return truncateDiagnosticDetails(details)
	try {
		const serialized = JSON.stringify(details, (_key, value) => typeof value === 'bigint' ? value.toString() : value)
		if (serialized !== undefined) return truncateDiagnosticDetails(serialized)
	} catch {
		const message = getErrorMessage(details)
		if (message !== undefined) return truncateDiagnosticDetails(message)
	}
	try {
		return truncateDiagnosticDetails(String(details))
	} catch {
		return undefined
	}
}

export function printError(error: unknown) {
	console.error(error)
	const forwardedDiagnostics = getForwardedDiagnostics(error)
	if (forwardedDiagnostics !== undefined) console.error('forwarded diagnostics:', forwardedDiagnostics)
	if (error instanceof Error) {
		try {
			if ('data' in error) console.error('data: ', JSON.stringify(error.data))
			if ('code' in error) console.error('code: ', JSON.stringify(error.code))
		} catch(stringifyError) {
			console.error(stringifyError)
		}
	}
}

function generateDebugId() {
	return globalThis.crypto.randomUUID().slice(0, 8)
}

function createErrorReport(error: unknown, metadata: ErrorReportMetadata, policy: ErrorPolicyEntry, defaultCode: string, message: string): InterceptorErrorReport {
	const debugId = metadata.debugId ?? generateDebugId()
	const source = metadata.source ?? 'internal'
	return {
		timestamp: new Date(),
		message,
		cause: getErrorMessage(error),
		source,
		code: metadata.code ?? defaultCode,
		category: metadata.category ?? policy.category,
		severity: metadata.severity ?? policy.severity,
		userVisible: metadata.userVisible ?? policy.userVisible,
		debugId,
		details: stringifyDiagnosticDetails(metadata.details),
	}
}

async function appendErrorDiagnostic(report: InterceptorErrorReport) {
	try {
		await appendInterceptorErrorDiagnostic(report)
	} catch (error: unknown) {
		console.error('Failed to persist interceptor error diagnostic.')
		printError(error)
	}
}

function popupMessageFromUnexpectedReport(report: InterceptorErrorReport) {
	return {
		method: 'popup_UnexpectedErrorOccured' as const,
		data: {
			timestamp: report.timestamp,
			message: report.message,
			source: report.source,
			code: report.code,
			debugId: report.debugId,
		}
	}
}

export async function reportUnexpectedError(error: unknown, metadata: ErrorReportMetadata = {}) {
	if ((metadata.suppressExpectedInfrastructure ?? true) && isExpectedInfrastructureError(error)) return
	const defaultCode = isWrappedNewBlockAbort(error) ? 'wrapped_new_block_abort' : 'unexpected_error'
	const report = createErrorReport(error, metadata, ERROR_REPORTING_POLICY.unexpected, defaultCode, metadata.displayMessage ?? normalizeUnexpectedError(error).message)
	console.error('Unexpected Interceptor error', {
		debugId: report.debugId,
		source: report.source,
		code: report.code,
		category: report.category,
		severity: report.severity,
	})
	printError(error)
	console.trace()
	await appendErrorDiagnostic(report)
	const errorMessage = popupMessageFromUnexpectedReport(report)
	let messageToBroadcast = errorMessage
	try {
		await setLatestUnexpectedError(errorMessage)
	} catch (storageError: unknown) {
		console.error('Failed to persist unexpected error.')
		printError(storageError)
		messageToBroadcast = { ...errorMessage, data: { ...errorMessage.data, code: 'unexpected_error_persist_failed' } }
	}
	try {
		await sendPopupMessageToOpenWindowsWithoutUnexpectedErrorReport(messageToBroadcast)
	} catch (broadcastError: unknown) {
		console.error('Failed to broadcast unexpected error to open popup windows.')
		printError(broadcastError)
	}
}

export async function reportNonFatalError(error: unknown, metadata: ErrorReportMetadata = {}) {
	await reportUnexpectedError(error, { ...metadata, code: metadata.code ?? 'non_fatal_error' })
}

export async function reportLocalRecovery(error: unknown, metadata: LocalRecoveryMetadata) {
	const report = logLocalRecovery(error, metadata)
	await appendErrorDiagnostic(report)
}

export function reportLocalRecoveryBestEffort(error: unknown, metadata: LocalRecoveryMetadata) {
	const report = logLocalRecovery(error, metadata)
	void appendErrorDiagnostic(report)
}

function logLocalRecovery(error: unknown, metadata: LocalRecoveryMetadata) {
	const report = createErrorReport(error, {
		source: metadata.source,
		code: metadata.code,
		category: metadata.category ?? ERROR_REPORTING_POLICY.localRecovery.category,
		severity: ERROR_REPORTING_POLICY.localRecovery.severity,
		userVisible: ERROR_REPORTING_POLICY.localRecovery.userVisible,
		details: metadata.details,
	}, ERROR_REPORTING_POLICY.localRecovery, metadata.code, metadata.message ?? getErrorMessage(error) ?? 'Recovered from an Interceptor error.')
	console.warn('Local Interceptor recovery', {
		debugId: report.debugId,
		source: report.source,
		code: report.code,
		category: report.category,
		severity: report.severity,
		message: report.message,
		...(report.cause === undefined ? {} : { cause: report.cause }),
	})
	if (report.details !== undefined) console.warn(report.details)
	printError(error)
	return report
}

export function reportLocalRecoveryAtAsyncBoundary(operation: () => Promise<unknown>, metadata: LocalRecoveryMetadata) {
	void operation().catch((error: unknown) => {
		reportLocalRecoveryBestEffort(error, metadata)
	})
}

export function reportUnexpectedErrorAtAsyncBoundary(operation: () => Promise<unknown>, metadata: ErrorReportMetadata = {}) {
	void operation().catch((error: unknown) => {
		void reportUnexpectedError(error, metadata)
	})
}

export function withUnexpectedErrorReporting<Args extends readonly unknown[]>(callback: (...args: Args) => Promise<unknown>, metadata: ErrorReportMetadata = {}) {
	return (...args: Args) => {
		reportUnexpectedErrorAtAsyncBoundary(async () => await callback(...args), metadata)
		return undefined
	}
}
