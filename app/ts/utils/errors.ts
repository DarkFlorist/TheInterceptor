import { sendPopupMessageToOpenWindowsWithoutUnexpectedErrorReport } from '../background/backgroundUtils.js'
import { appendInterceptorErrorDiagnostic, setLatestUnexpectedError } from '../background/storageVariables.js'
import type { JsonRpcErrorResponse } from '../types/JsonRpc-types.js'
import type { InterceptorErrorCategory, InterceptorErrorDiagnostic, InterceptorErrorSeverity } from '../types/errorDiagnostics.js'
import type { UnexpectedErrorOccured } from '../types/interceptor-reply-messages.js'
import { getErrorMessage, getInterceptorInternalErrorClassification, isBrowserFetchTransportError } from './caughtErrors.js'
import { NEW_BLOCK_ABORT } from './constants.js'
import { createErrorDebugId, createUnexpectedErrorPopupMessage } from './unexpectedErrorPopupMessage.js'
import { stringifyDiagnosticDetails } from './diagnosticSerialization.js'
export { createInterceptorInternalError, getErrorMessage, hasInterceptorInternalErrorCode } from './caughtErrors.js'

export const GENERIC_UNEXPECTED_ERROR_MESSAGE = 'An internal Interceptor error occurred. Please see The Interceptor console for technical details.'

type ErrorReportMetadata = {
	source?: string
	code?: string
	debugId?: string
	displayMessage?: string
	category?: InterceptorErrorCategory
	severity?: InterceptorErrorSeverity
	details?: unknown
	rawError?: string
	userVisible?: boolean
	suppressExpectedHandledErrors?: boolean
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
} as const satisfies Record<string, ErrorPolicyEntry>

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
	if (getInterceptorInternalErrorClassification(error) === 'failedToFetch') return true
	return isBrowserFetchTransportError(error)
}

export const isNewBlockAbort = (error: unknown) => getErrorMessage(error) === NEW_BLOCK_ABORT

export const isWrappedNewBlockAbort = (error: unknown) => {
	const message = getErrorMessage(error)
	return message !== undefined && message !== NEW_BLOCK_ABORT && message.includes(NEW_BLOCK_ABORT)
}

export type CaughtErrorClassification = 'newBlockAbort' | 'failedToFetch' | 'handled' | 'unexpected'

export function classifyCaughtError(error: unknown): CaughtErrorClassification {
	if (isNewBlockAbort(error)) return 'newBlockAbort'
	if (isFailedToFetchError(error)) return 'failedToFetch'
	const internalClassification = getInterceptorInternalErrorClassification(error)
	if (internalClassification !== undefined) return internalClassification
	return 'unexpected'
}

export const isExpectedInfrastructureError = (error: unknown) => {
	const classification = classifyCaughtError(error)
	return classification === 'newBlockAbort' || classification === 'failedToFetch'
}

export const shouldSuppressUnexpectedErrorReport = (error: unknown) => classifyCaughtError(error) !== 'unexpected'

function getForwardedDiagnostics(error: unknown): string | undefined {
	if (typeof error !== 'object' || error === null) return undefined
	try {
		if (Object.getOwnPropertyDescriptor(error, 'method')?.value !== 'InterceptorError') return undefined
		const params = Object.getOwnPropertyDescriptor(error, 'params')?.value
		if (!Array.isArray(params) || params.length !== 1) return undefined
		const message = Object.getOwnPropertyDescriptor(params, '0')?.value
		return typeof message === 'string' ? message : undefined
	} catch {
		// A hostile descriptor cannot prevent the raw error from being recorded.
		return undefined
	}
}

function normalizeUnexpectedError(error: unknown) {
	if (typeof error === 'object' && error !== null) {
		const message = getErrorMessage(error)
		if (message !== undefined) return { message }
	}
	return { message: GENERIC_UNEXPECTED_ERROR_MESSAGE }
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

function createErrorReport(error: unknown, metadata: ErrorReportMetadata, policy: ErrorPolicyEntry, defaultCode: string, message: string): InterceptorErrorReport {
	const debugId = metadata.debugId ?? createErrorDebugId()
	const source = metadata.source ?? 'internal'
	return {
		timestamp: new Date(),
		message,
		cause: getErrorMessage(error),
		rawError: metadata.rawError ?? getForwardedDiagnostics(error) ?? stringifyDiagnosticDetails(error),
		source,
		code: metadata.code ?? defaultCode,
		category: metadata.category ?? policy.category,
		severity: metadata.severity ?? policy.severity,
		userVisible: metadata.userVisible ?? policy.userVisible,
		debugId,
		details: stringifyDiagnosticDetails(metadata.details),
	}
}

function formatErrorReportConsoleMetadata(report: InterceptorErrorReport) {
	const parts = [
		`code=${ report.code }`,
		`message=${ JSON.stringify(report.message) }`,
		`debugId=${ report.debugId }`,
		`source=${ report.source }`,
		`category=${ report.category }`,
		`severity=${ report.severity }`,
	]
	if (report.cause !== undefined) parts.push(`cause=${ JSON.stringify(report.cause) }`)
	return parts.join(' ')
}

function formatLocalRecoveryConsoleMessage(report: InterceptorErrorReport) {
	return `Local Interceptor recovery: ${ formatErrorReportConsoleMetadata(report) }`
}

function logUnexpectedError(error: unknown, report: InterceptorErrorReport) {
	console.error(`Unexpected Interceptor error: ${ formatErrorReportConsoleMetadata(report) }`)
	if (report.details !== undefined) console.error(`Unexpected Interceptor error details: ${ report.details }`)
	printError(error)
}

async function appendErrorDiagnostic(report: InterceptorErrorReport) {
	try {
		if (await appendInterceptorErrorDiagnostic(report) === 'storage-full') {
			console.error('Failed to persist interceptor error diagnostic because extension storage is full.', report)
		}
	} catch (error: unknown) {
		console.error('Failed to persist interceptor error diagnostic.')
		printError(error)
	}
}

export async function reportUnexpectedError(error: unknown, metadata: ErrorReportMetadata = {}): Promise<UnexpectedErrorOccured | undefined> {
	if ((metadata.suppressExpectedHandledErrors ?? true) && shouldSuppressUnexpectedErrorReport(error)) return
	const defaultCode = isWrappedNewBlockAbort(error) ? 'wrapped_new_block_abort' : 'unexpected_error'
	const report = createErrorReport(error, metadata, ERROR_REPORTING_POLICY.unexpected, defaultCode, metadata.displayMessage ?? normalizeUnexpectedError(error).message)
	logUnexpectedError(error, report)
	await appendErrorDiagnostic(report)
	const errorMessage = createUnexpectedErrorPopupMessage(report)
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
	return errorMessage
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
	console.warn(formatLocalRecoveryConsoleMessage(report))
	if (report.details !== undefined) console.warn(`Local Interceptor recovery details: ${ report.details }`)
	printError(error)
	return report
}

export function reportLocalRecoveryAtAsyncBoundary(operation: () => Promise<unknown>, metadata: LocalRecoveryMetadata) {
	void operation().catch((error: unknown) => {
		reportLocalRecoveryBestEffort(error, metadata)
	})
}
