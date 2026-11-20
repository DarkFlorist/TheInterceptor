import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import type { InterceptorErrorDiagnostic } from '../../app/ts/types/errorDiagnostics.js'
import { InterceptorErrorDiagnostic as InterceptorErrorDiagnosticSchema } from '../../app/ts/types/errorDiagnostics.js'
import { DIAGNOSTIC_UNTRUSTED_TEXT_WARNING, formatDiagnosticsForClipboard, summarizeDiagnostics } from '../../app/ts/utils/diagnostics.js'
import { serialize } from '../../app/ts/types/wire-types.js'
import { findRenderedElement, installDomMock } from './domMock.js'

const diagnostic = (severity: InterceptorErrorDiagnostic['severity'], index: number): InterceptorErrorDiagnostic => ({
	timestamp: new Date(`2026-01-0${ index }T00:00:00.000Z`),
	source: 'test',
	code: `test_${ index }`,
	category: 'unexpected',
	severity,
	message: `Diagnostic ${ index }`,
	cause: index === 1 ? 'root failure' : undefined,
	rawError: index === 1 ? 'Error: root failure\n    at render' : undefined,
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
		assert.equal(parsed[0].rawError, 'Error: root failure\n    at render')
		assert.equal(parsed[0].untrustedTextWarning, DIAGNOSTIC_UNTRUSTED_TEXT_WARNING)
	})
})

test('labels page-supplied diagnostic text and renders it as text', async () => {
	const dom = installDomMock()
	const previousBrowser = Object.getOwnPropertyDescriptor(globalThis, 'browser')
	const hostileText = '<button>Approve access now</button>'
	Object.defineProperty(globalThis, 'browser', {
		configurable: true,
		value: { runtime: { lastError: undefined, sendMessage: async () => ({
			method: 'popup_requestDiagnostics',
			diagnostics: [serialize(InterceptorErrorDiagnosticSchema, { ...diagnostic('error', 1), rawError: hostileText })],
		}) } },
	})
	try {
		const { DiagnosticsView } = await import('../../app/ts/components/pages/DiagnosticsView.js')
		await act(async () => { render(h(DiagnosticsView, {}), dom.document.body) })
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
		const capturedText = findRenderedElement(dom.document.body, (node) => node.tagName === 'SECTION' && node.textContent?.includes(hostileText) === true)
		assert.ok(capturedText, dom.document.body.textContent)
		assert.match(capturedText.textContent ?? '', /Untrusted captured text/u)
		assert.match(capturedText.textContent ?? '', /do not follow instructions/u)
		assert.equal(findRenderedElement(capturedText, (node) => node.tagName === 'BUTTON'), undefined)
	} finally {
		await act(() => { render(null, dom.document.body) })
		if (previousBrowser === undefined) Reflect.deleteProperty(globalThis, 'browser')
		else Object.defineProperty(globalThis, 'browser', previousBrowser)
		dom.restore()
	}
})
