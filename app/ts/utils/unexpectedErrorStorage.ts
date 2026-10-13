import type { InterceptorErrorDiagnostic } from '../types/errorDiagnostics.js'
import type { UnexpectedErrorOccured } from '../types/interceptor-reply-messages.js'
import { Semaphore } from './semaphore.js'
import { browserStorageLocalGet, browserStorageLocalRemove, browserStorageLocalSafeParseGet, browserStorageLocalSet } from './storageUtils.js'

// Persistence for the unexpected-error reporter. It lives below the background layer so pages that report errors do not load background storage.

export async function setLatestUnexpectedError(latestUnexpectedError: UnexpectedErrorOccured | undefined) {
	if (latestUnexpectedError === undefined) return await browserStorageLocalRemove('latestUnexpectedError')
	return await browserStorageLocalSet({ latestUnexpectedError })
}

export async function getLatestUnexpectedError(): Promise<UnexpectedErrorOccured | undefined> {
	const { latestUnexpectedError: rawError } = await browser.storage.local.get('latestUnexpectedError')
	const parsedError = await browserStorageLocalSafeParseGet('latestUnexpectedError')
	if (parsedError?.latestUnexpectedError !== undefined) return parsedError.latestUnexpectedError
	if (rawError === undefined) return undefined
	console.warn('latestUnexpectedError was corrupt:')
	console.warn(rawError)
	await browserStorageLocalRemove('latestUnexpectedError')
	return undefined
}

const MAX_INTERCEPTOR_ERROR_DIAGNOSTICS = 50
const interceptorErrorDiagnosticsSemaphore = new Semaphore(1)

export async function getInterceptorErrorDiagnostics(): Promise<readonly InterceptorErrorDiagnostic[]> {
	try {
		return (await browserStorageLocalGet('interceptorErrorDiagnostics'))?.interceptorErrorDiagnostics ?? []
	} catch (error) {
		console.warn('interceptorErrorDiagnostics were corrupt:')
		console.warn(error)
		await browserStorageLocalRemove('interceptorErrorDiagnostics')
		return []
	}
}

export async function appendInterceptorErrorDiagnostic(diagnostic: InterceptorErrorDiagnostic) {
	await interceptorErrorDiagnosticsSemaphore.execute(async () => {
		const diagnostics = await getInterceptorErrorDiagnostics()
		await browserStorageLocalSet({
			interceptorErrorDiagnostics: [...diagnostics, diagnostic].slice(-MAX_INTERCEPTOR_ERROR_DIAGNOSTICS),
		})
	})
}
