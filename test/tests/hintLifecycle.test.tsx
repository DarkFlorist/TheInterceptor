import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import Hint, { showHint } from '../../app/ts/components/subcomponents/Hint.js'
import { installDomMock } from './domMock.js'

type TestNode = {
	readonly childNodes?: readonly TestNode[]
	readonly dispatchEvent?: (event: Event) => boolean
	readonly tagName?: string
}

function findElement(node: TestNode | undefined, tagName: string): TestNode | undefined {
	if (node?.tagName === tagName.toUpperCase()) return node
	for (const child of node?.childNodes ?? []) {
		const match = findElement(child, tagName)
		if (match !== undefined) return match
	}
	return undefined
}

describe('Hint lifecycle', () => {
	test('clears pending timers and removes event listeners on unmount', async () => {
		const dom = installDomMock()
		const originalSetTimeout = globalThis.setTimeout
		const originalClearTimeout = globalThis.clearTimeout
		let scheduledTimers: Array<ReturnType<typeof setTimeout>> = []
		const clearedTimers: Array<ReturnType<typeof setTimeout> | undefined> = []
		globalThis.setTimeout = (callback, delay, ...parameters) => {
			const timerId = originalSetTimeout(callback, delay, ...parameters)
			scheduledTimers.push(timerId)
			return timerId
		}
		globalThis.clearTimeout = (timerId) => {
			clearedTimers.push(timerId)
			originalClearTimeout(timerId)
		}
		try {
			await act(() => {
				render(<Hint><button data-tooltip = 'Tooltip'>Copy</button></Hint>, dom.document.body)
			})
			const button = findElement(dom.document.body, 'button')
			if (button?.dispatchEvent === undefined) throw new Error('button was not rendered')
			showHint(button, { content: 'Copied', delay: 60_000, x: 0, y: 0 })
			button.dispatchEvent(new Event('mouseover', { bubbles: true }))
			assert.equal(scheduledTimers.length, 2)
			const timersAtUnmount = [...scheduledTimers]

			await act(() => { render(null, dom.document.body) })
			assert.equal(timersAtUnmount.every((timerId) => clearedTimers.includes(timerId)), true)

			scheduledTimers = []
			showHint(button, { content: 'After unmount', delay: 60_000, x: 0, y: 0 })
			assert.deepEqual(scheduledTimers, [])
		} finally {
			globalThis.setTimeout = originalSetTimeout
			globalThis.clearTimeout = originalClearTimeout
			render(null, dom.document.body)
			dom.restore()
		}
	})
})
