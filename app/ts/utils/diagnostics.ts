import { InterceptorErrorDiagnostic, type InterceptorErrorSeverity } from '../types/errorDiagnostics.js'
import { serialize } from '../types/wire-types.js'

export type DiagnosticSummary = Readonly<Record<InterceptorErrorSeverity, number>> & { total: number }

export function summarizeDiagnostics(diagnostics: readonly InterceptorErrorDiagnostic[]): DiagnosticSummary {
	let info = 0
	let warning = 0
	let error = 0
	for (const diagnostic of diagnostics) {
		switch (diagnostic.severity) {
			case 'info': info += 1; break
			case 'warning': warning += 1; break
			case 'error': error += 1; break
		}
	}
	return { total: diagnostics.length, info, warning, error }
}

export function formatDiagnosticsForClipboard(diagnostics: readonly InterceptorErrorDiagnostic[]) {
	return JSON.stringify(diagnostics.map((diagnostic) => serialize(InterceptorErrorDiagnostic, diagnostic)), undefined, 2)
}
