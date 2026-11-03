import type { InterceptorErrorDiagnostic } from '../types/errorDiagnostics.js'
import { getErrorMessage } from '../utils/caughtErrors.js'
import { Semaphore } from '../utils/semaphore.js'
import { browserStorageLocalGet, browserStorageLocalRemove, browserStorageLocalSet } from '../utils/storageUtils.js'

const MAX_INTERCEPTOR_ERROR_DIAGNOSTICS = 50
const MAX_INTERCEPTOR_ERROR_DIAGNOSTICS_BYTES = 512_000
const interceptorErrorDiagnosticsSemaphore = new Semaphore(1)

function isDiagnosticStorageQuotaError(error: unknown) {
	return getErrorMessage(error)?.toLowerCase().includes('quota') ?? false
}

function diagnosticStorageBytes(diagnostics: readonly InterceptorErrorDiagnostic[]) {
	return new TextEncoder().encode(JSON.stringify(diagnostics)).length
}

function retainWithinDiagnosticBudget(diagnostics: InterceptorErrorDiagnostic[]) {
	while (diagnostics.length > 1 && diagnosticStorageBytes(diagnostics) > MAX_INTERCEPTOR_ERROR_DIAGNOSTICS_BYTES) diagnostics.shift()
	return diagnostics
}

function diagnosticStorageFailureRecord(diagnostic: InterceptorErrorDiagnostic): InterceptorErrorDiagnostic {
	return {
		...diagnostic,
		message: 'Full diagnostic could not be stored. See the extension console for the raw error.',
		cause: undefined,
		rawError: 'The raw error exceeded the diagnostic storage budget or available storage quota.',
		details: undefined,
	}
}

async function writeDiagnosticsWithQuotaRecovery(retained: InterceptorErrorDiagnostic[]): Promise<'stored' | 'storage-full'> {
	while (true) {
		try {
			await browserStorageLocalSet({ interceptorErrorDiagnostics: retained })
			return 'stored'
		} catch (error) {
			if (!isDiagnosticStorageQuotaError(error)) throw error
			if (retained.length === 1) return 'storage-full'
			retained.shift()
		}
	}
}

async function storeDiagnosticStorageFailureRecord(diagnostics: readonly InterceptorErrorDiagnostic[], diagnostic: InterceptorErrorDiagnostic): Promise<'stored' | 'storage-full'> {
	const retained = retainWithinDiagnosticBudget([...diagnostics, diagnosticStorageFailureRecord(diagnostic)].slice(-MAX_INTERCEPTOR_ERROR_DIAGNOSTICS))
	return await writeDiagnosticsWithQuotaRecovery(retained)
}

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

export async function appendInterceptorErrorDiagnostic(diagnostic: InterceptorErrorDiagnostic): Promise<'stored' | 'storage-full'> {
	return await interceptorErrorDiagnosticsSemaphore.execute(async () => {
		const diagnostics = await getInterceptorErrorDiagnostics()
		const retained = retainWithinDiagnosticBudget([...diagnostics, diagnostic].slice(-MAX_INTERCEPTOR_ERROR_DIAGNOSTICS))
		if (diagnosticStorageBytes(retained) > MAX_INTERCEPTOR_ERROR_DIAGNOSTICS_BYTES) return await storeDiagnosticStorageFailureRecord(diagnostics, diagnostic)
		if (await writeDiagnosticsWithQuotaRecovery(retained) === 'stored') return 'stored'
		return await storeDiagnosticStorageFailureRecord(diagnostics, diagnostic)
	})
}

export async function clearInterceptorErrorDiagnostics() {
	await interceptorErrorDiagnosticsSemaphore.execute(async () => {
		await browserStorageLocalRemove('interceptorErrorDiagnostics')
	})
}
