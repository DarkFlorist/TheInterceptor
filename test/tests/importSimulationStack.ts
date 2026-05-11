import * as assert from 'assert'
import { Signal } from '@preact/signals'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { ImportSimulationStack } from '../../app/ts/components/pages/ImportSimulationStack.js'
import { describe, run, runIfRoot, should } from '../micro-should.js'
import { installDomMock } from './someTimeAgo.js'

type RenderedVNode = Parameters<typeof render>[0]
type RenderTarget = Parameters<typeof render>[1]

type TestTreeNode = {
	tagName?: string
	textContent?: string
	childNodes?: TestTreeNode[]
	attributes?: Record<string, string | undefined>
	value?: string
	disabled?: boolean
	className?: string
}

function findElementsByTagName(node: TestTreeNode, tagName: string): TestTreeNode[] {
	const matches = node.tagName === tagName ? [node] : []
	for (const child of node.childNodes ?? []) {
		matches.push(...findElementsByTagName(child, tagName))
	}
	return matches
}

function getClassNames(node: TestTreeNode) {
	return node.attributes?.class ?? node.attributes?.className ?? node.className ?? ''
}

function findButtonByText(node: TestTreeNode, text: string) {
	return findElementsByTagName(node, 'BUTTON').find((button) => button.textContent?.trim() === text)
}

function renderIntoTestContainer(vnode: RenderedVNode, container: TestTreeNode) {
	render(vnode, container as unknown as RenderTarget)
}

async function main() {
	describe('ImportSimulationStack', () => {
		should('renders the simulation stack as a multiline textarea and preserves pasted text', async () => {
			const dom = installDomMock()
			const simulationInput = new Signal('{\n  "foo": "bar"\n}')

			await act(() => {
				renderIntoTestContainer(h(ImportSimulationStack, { close: () => undefined, simulationInput }), dom.document.body)
			})

			const textareas = findElementsByTagName(dom.document.body, 'TEXTAREA')
			assert.equal(textareas.length, 1)
			const [textarea] = textareas
			if (textarea === undefined) throw new Error('Expected simulation stack textarea to render')
			assert.equal(getClassNames(textarea).includes('simulation-stack-import-input'), true)
			assert.equal((textarea.value ?? textarea.textContent), simulationInput.value)
			assert.equal(findElementsByTagName(dom.document.body, 'INPUT').length, 0)
			assert.equal(dom.document.body.textContent?.includes('Interceptor Simulation Stack:'), true)

			dom.restore()
		})

		should('marks invalid JSON and disables import', async () => {
			const dom = installDomMock()
			const simulationInput = new Signal('not json')

			await act(() => {
				renderIntoTestContainer(h(ImportSimulationStack, { close: () => undefined, simulationInput }), dom.document.body)
			})

			const [textarea] = findElementsByTagName(dom.document.body, 'TEXTAREA')
			if (textarea === undefined) throw new Error('Expected simulation stack textarea to render')
			const importButton = findButtonByText(dom.document.body, 'Import')
			assert.equal(getClassNames(textarea).includes('simulation-stack-import-input-invalid'), true)
			assert.equal(dom.document.body.textContent?.includes('not a valid JSON'), true)
			assert.equal(importButton?.disabled, true)

			dom.restore()
		})

		should('shows schema validation errors for valid JSON that is not a simulation stack export', async () => {
			const dom = installDomMock()
			const simulationInput = new Signal('{\n  "foo": "bar"\n}')

			await act(() => {
				renderIntoTestContainer(h(ImportSimulationStack, { close: () => undefined, simulationInput }), dom.document.body)
			})

			assert.equal(dom.document.body.textContent?.includes('The input needs to be valid Interceptor Simulation Stack Export:'), true)

			dom.restore()
		})
	})
}

await runIfRoot(async () => {
	await main()
	await run()
}, import.meta)
