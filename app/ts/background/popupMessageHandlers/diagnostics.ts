import type { UnexpectedErrorOccured } from '../../types/interceptor-reply-messages.js'
import { reportUnexpectedError } from '../../utils/errors.js'
import { getLatestUnexpectedError } from '../../utils/unexpectedErrorStorage.js'

export const requestLatestUnexpectedError = async () => ({ method: 'popup_requestLatestUnexpectedError' as const, latestUnexpectedError: await getLatestUnexpectedError() })

export async function reportUnexpectedErrorInWindow(parsedRequest: UnexpectedErrorOccured) {
	await reportUnexpectedError(parsedRequest.data.message, {
		displayMessage: parsedRequest.data.message,
		source: parsedRequest.data.source,
		code: parsedRequest.data.code,
		debugId: parsedRequest.data.debugId,
		details: parsedRequest.data,
		suppressExpectedHandledErrors: false,
	})
}
