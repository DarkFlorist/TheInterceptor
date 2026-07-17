import * as assert from 'assert'
import { describe, test } from 'bun:test'
import type { InterceptorErrorDiagnostic } from '../../app/ts/types/errorDiagnostics.js'
import { formatDiagnosticsForClipboard, summarizeDiagnostics } from '../../app/ts/utils/diagnostics.js'

const diagnostic = (severity: InterceptorErrorDiagnostic['severity'], index: number): InterceptorErrorDiagnostic => ({
	timestamp: new Date(`2026-01-0${ index }T00:00:00.000Z`),
	source: 'test',
	code: `test_${ index }`,
	category: 'unexpected',
	severity,
	message: `Diagnostic ${ index }`,
	cause: index === 1 ? 'root failure' : undefined,
	userVisible: severity === 'error',
	debugId: `debug-${ index }`,
	details: undefined,
})

describe('diagnostics view data', () => {
	const diagnostics = [diagnostic('error', 1), diagnostic('warning', 2), diagnostic('info', 3), diagnostic('error', 4)]

	test('summarizes diagnostics by severity', () => {
		assert.deepEqual(summarizeDiagnostics(diagnostics), { total: 4, error: 2, warning: 1, info: 1 })
	})

	test('formats diagnostics with serialized timestamps for copying', () => {
		const formatted = formatDiagnosticsForClipboard(diagnostics)
		const parsed = JSON.parse(formatted)

		assert.equal(parsed.length, 4)
		assert.match(parsed[0].timestamp, /^0x[0-9a-f]+$/)
		assert.equal(parsed[0].cause, 'root failure')
	})
})
