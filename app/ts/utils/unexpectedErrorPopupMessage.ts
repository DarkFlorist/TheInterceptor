import type { InterceptorErrorDiagnostic } from '../types/errorDiagnostics.js'
import type { UnexpectedErrorOccured } from '../types/interceptor-reply-messages.js'

type UnexpectedErrorPopupMessageInput = Pick<InterceptorErrorDiagnostic, 'timestamp' | 'message' | 'source' | 'code' | 'debugId'>

export function createErrorDebugId() {
	return globalThis.crypto.randomUUID().slice(0, 8)
}

export function createUnexpectedErrorPopupMessage(report: UnexpectedErrorPopupMessageInput): UnexpectedErrorOccured {
	return {
		method: 'popup_UnexpectedErrorOccured',
		data: {
			timestamp: report.timestamp,
			message: report.message,
			source: report.source,
			code: report.code,
			debugId: report.debugId,
		}
	}
}
