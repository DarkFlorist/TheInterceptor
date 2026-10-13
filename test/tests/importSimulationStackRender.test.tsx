import * as assert from 'node:assert'
import { Signal } from '@preact/signals'
import { describe, test } from 'bun:test'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { ImportSimulationStack } from '../../app/ts/components/pages/ImportSimulationStack.js'
import { installDomMock } from './domMock.js'
import { collectElements, hasClass } from './domQueries.js'

describe('ImportSimulationStack', () => {
	test('renders the simulation stack as a multiline textarea and preserves pasted text', async () => {
		const dom = installDomMock()
		const simulationInput = new Signal('{\n  "foo": "bar"\n}')

		await act(() => {
			render(h(ImportSimulationStack, { close: () => undefined, simulationInput }), dom.document.body)
		})

		const textareas = collectElements(dom.document.body, 'textarea')
		assert.equal(textareas.length, 1)
		const [textarea] = textareas
		assert.ok(textarea !== undefined, 'Expected simulation stack textarea to render')
		assert.equal(hasClass(textarea, 'simulation-stack-import-input'), true)
		assert.equal(collectElements(dom.document.body, 'input').length, 0)
		assert.equal(dom.document.body.textContent.includes('Interceptor Simulation Stack:'), true)

		dom.restore()
	})

	test('marks invalid JSON and disables import', async () => {
		const dom = installDomMock()
		const simulationInput = new Signal('not json')

		await act(() => {
			render(h(ImportSimulationStack, { close: () => undefined, simulationInput }), dom.document.body)
		})

		const [textarea] = collectElements(dom.document.body, 'textarea')
		assert.ok(textarea !== undefined, 'Expected simulation stack textarea to render')
		assert.equal(hasClass(textarea, 'simulation-stack-import-input-invalid'), true)
		assert.equal(dom.document.body.textContent.includes('not a valid JSON'), true)

		dom.restore()
	})

	test('shows schema validation errors for valid JSON that is not a simulation stack export', async () => {
		const dom = installDomMock()
		const simulationInput = new Signal('{\n  "foo": "bar"\n}')

		await act(() => {
			render(h(ImportSimulationStack, { close: () => undefined, simulationInput }), dom.document.body)
		})

		assert.equal(dom.document.body.textContent.includes('The input needs to be valid Interceptor Simulation Stack Export:'), true)

		dom.restore()
	})
})
