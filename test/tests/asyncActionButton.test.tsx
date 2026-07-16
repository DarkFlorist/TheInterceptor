import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { AsyncActionButton } from '../../app/ts/components/subcomponents/AsyncAction.js'
import { installDomMock } from './domMock.js'

type TestNode = {
	readonly childNodes?: readonly TestNode[]
	readonly getAttribute?: (name: string) => string | null
	readonly style?: Record<string, string>
	readonly tagName?: string
	readonly textContent?: string | null
}

function findByClass(node: TestNode | undefined, className: string): TestNode | undefined {
	if (node?.getAttribute?.('class')?.split(/\s+/).includes(className)) return node
	for (const child of node?.childNodes ?? []) {
		const match = findByClass(child, className)
		if (match !== undefined) return match
	}
	return undefined
}

function collectElements(node: TestNode | undefined, tagName: string, results: TestNode[] = []) {
	if (node?.tagName === tagName.toUpperCase()) results.push(node)
	for (const child of node?.childNodes ?? []) collectElements(child, tagName, results)
	return results
}

describe('AsyncActionButton', () => {
	test('keeps the pending indicator outside the original text layout', async () => {
		const dom = installDomMock()
		try {
			await act(() => {
				render(h(AsyncActionButton, {
					state: 'inactive',
					text: 'Simulating',
					pendingText: 'Switching to simulating mode...',
					keepTextWhilePending: true,
					onClick: () => undefined,
				}), dom.document.body)
			})

			const inactiveContent = findByClass(dom.document.body, 'async-action-button__stable-content')
			const inactiveSlot = findByClass(dom.document.body, 'async-action-button__status-slot')
			assert.notEqual(inactiveContent, undefined)
			assert.equal(inactiveContent?.style?.position, 'relative')
			assert.equal(inactiveSlot?.style?.position, 'absolute')
			assert.equal(inactiveSlot?.style?.right, 'calc(100% + 0.125em)')
			assert.equal(inactiveSlot?.style?.width, '0.75em')
			assert.equal(inactiveSlot?.style?.visibility, 'hidden')
			assert.equal(collectElements(inactiveSlot, 'svg').length, 0)
			assert.equal(inactiveContent?.textContent, 'Simulating')

			await act(() => {
				render(h(AsyncActionButton, {
					state: 'pending',
					text: 'Simulating',
					pendingText: 'Switching to simulating mode...',
					keepTextWhilePending: true,
					onClick: () => undefined,
				}), dom.document.body)
			})

			const pendingContent = findByClass(dom.document.body, 'async-action-button__stable-content')
			const pendingSlot = findByClass(dom.document.body, 'async-action-button__status-slot')
			assert.equal(pendingSlot?.style?.position, 'absolute')
			assert.equal(pendingSlot?.style?.right, 'calc(100% + 0.125em)')
			assert.equal(pendingSlot?.style?.width, '0.75em')
			assert.equal(pendingSlot?.style?.visibility, 'visible')
			assert.equal(collectElements(pendingSlot, 'svg').length, 1)
			assert.equal(pendingContent?.textContent, 'Simulating')
		} finally {
			render(null, dom.document.body)
			dom.restore()
		}
	})
})
