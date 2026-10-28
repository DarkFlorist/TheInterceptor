import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import Hint, { showHint } from '../../app/ts/components/subcomponents/Hint.js'
import { installDomMock } from './domMock.js'
import { collectElements } from './domQueries.js'
import { replaceGlobal } from '../harness/globals.js'

type TimerId = ReturnType<typeof setTimeout>

describe('Hint lifecycle', () => {
	test('clears pending timers and removes event listeners on unmount', async () => {
		const dom = installDomMock()
		const originalSetTimeout = globalThis.setTimeout
		const originalClearTimeout = globalThis.clearTimeout
		let scheduledTimers: TimerId[] = []
		const clearedTimers: (TimerId | undefined)[] = []
		const restoreSetTimeout = replaceGlobal('setTimeout', (callback: (...callbackArguments: unknown[]) => void, delay?: number, ...callbackArguments: unknown[]) => {
			const timerId = originalSetTimeout(callback, delay, ...callbackArguments)
			scheduledTimers.push(timerId)
			return timerId
		})
		const restoreClearTimeout = replaceGlobal('clearTimeout', (timerId: TimerId | undefined) => {
			clearedTimers.push(timerId)
			originalClearTimeout(timerId)
		})
		try {
			await act(() => {
				render(<Hint><button data-tooltip = 'Tooltip'>Copy</button></Hint>, dom.document.body)
			})
			const button = collectElements(dom.document.body, 'button')[0]
			assert.ok(button !== undefined, 'button was not rendered')
			showHint(button, { content: 'Copied', delay: 60_000, x: 0, y: 0 })
			button.dispatchEvent(new Event('mouseover', { bubbles: true }))
			assert.equal(scheduledTimers.length, 2)
			const timersAtUnmount = [...scheduledTimers]

			await act(() => { render(undefined, dom.document.body) })
			assert.equal(timersAtUnmount.every((timerId) => clearedTimers.includes(timerId)), true)

			scheduledTimers = []
			showHint(button, { content: 'After unmount', delay: 60_000, x: 0, y: 0 })
			assert.deepEqual(scheduledTimers, [])
		} finally {
			restoreClearTimeout()
			restoreSetTimeout()
			render(undefined, dom.document.body)
			dom.restore()
		}
	})
})
