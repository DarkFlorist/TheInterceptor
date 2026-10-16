import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import Hint, { showHint } from '../../app/ts/components/subcomponents/Hint.js'
import { installDomMock } from './domMock.js'

type TestNode = {
	readonly childNodes?: readonly TestNode[]
	readonly dispatchEvent?: (event: Event) => boolean
	readonly getAttribute?: (name: string) => unknown
	readonly style?: Record<string, unknown>
	readonly tagName?: string
	readonly textContent?: string
}

function findElement(node: TestNode | undefined, tagName: string): TestNode | undefined {
	if (node?.tagName === tagName.toUpperCase()) return node
	for (const child of node?.childNodes ?? []) {
		const match = findElement(child, tagName)
		if (match !== undefined) return match
	}
	return undefined
}

function findElementByClass(node: TestNode | undefined, className: string): TestNode | undefined {
	if (node?.getAttribute?.('class') === className) return node
	for (const child of node?.childNodes ?? []) {
		const match = findElementByClass(child, className)
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

	test('shows the tooltip of a focused element until it loses focus', async () => {
		const dom = installDomMock()
		try {
			await act(() => {
				render(<Hint>
					<span data-tooltip = 'Focused explanation' tabIndex = { 0 }>Warning</span>
					<div data-tooltip = 'Wrapper tooltip'><button>Nested control</button></div>
				</Hint>, dom.document.body)
			})
			const focusableTooltip = findElement(dom.document.body, 'span')
			const nestedButton = findElement(dom.document.body, 'button')
			if (focusableTooltip?.dispatchEvent === undefined || nestedButton?.dispatchEvent === undefined) throw new Error('tooltip targets were not rendered')

			await act(() => { focusableTooltip.dispatchEvent?.(new Event('focusin', { bubbles: true })) })
			assert.equal(findElementByClass(dom.document.body, 'preact-hint__content')?.textContent, 'Focused explanation')

			await act(() => { focusableTooltip.dispatchEvent?.(new Event('focusout', { bubbles: true })) })
			assert.equal(findElementByClass(dom.document.body, 'preact-hint__content'), undefined)

			await act(() => { nestedButton.dispatchEvent?.(new Event('focusin', { bubbles: true })) })
			assert.equal(findElementByClass(dom.document.body, 'preact-hint__content'), undefined)
		} finally {
			render(null, dom.document.body)
			dom.restore()
		}
	})

	test('keeps the tooltip of a focused element when the pointer leaves it or another tooltip', async () => {
		const dom = installDomMock()
		try {
			await act(() => {
				render(<Hint>
					<span data-tooltip = 'Focused explanation' tabIndex = { 0 }>Warning</span>
					<div class = 'other-tooltip' data-tooltip = 'Hovered tooltip'>Other</div>
				</Hint>, dom.document.body)
			})
			const focusableTooltip = findElement(dom.document.body, 'span')
			const otherTooltip = findElementByClass(dom.document.body, 'other-tooltip')
			if (focusableTooltip?.dispatchEvent === undefined || otherTooltip?.dispatchEvent === undefined) throw new Error('tooltip targets were not rendered')

			await act(() => { focusableTooltip.dispatchEvent?.(new Event('focusin', { bubbles: true })) })
			await act(() => { focusableTooltip.dispatchEvent?.(new Event('mouseout', { bubbles: true })) })
			assert.equal(findElementByClass(dom.document.body, 'preact-hint__content')?.textContent, 'Focused explanation')

			await act(() => { otherTooltip.dispatchEvent?.(new Event('mouseout', { bubbles: true })) })
			assert.equal(findElementByClass(dom.document.body, 'preact-hint__content')?.textContent, 'Focused explanation')

			await act(() => { focusableTooltip.dispatchEvent?.(new Event('focusout', { bubbles: true })) })
			await act(() => { focusableTooltip.dispatchEvent?.(new Event('mouseout', { bubbles: true })) })
			assert.equal(findElementByClass(dom.document.body, 'preact-hint__content'), undefined)
		} finally {
			render(null, dom.document.body)
			dom.restore()
		}
	})

	test('hides the tooltip of a focused element that is removed without a focusout', async () => {
		const dom = installDomMock()
		try {
			const renderTooltips = (isFocusableTooltipShown: boolean) => render(<Hint>
				{ isFocusableTooltipShown ? <span data-tooltip = 'Focused explanation' tabIndex = { 0 }>Warning</span> : <></> }
				<div class = 'other-tooltip' data-tooltip = 'Hovered tooltip'>Other</div>
			</Hint>, dom.document.body)
			await act(() => { renderTooltips(true) })
			const focusableTooltip = findElement(dom.document.body, 'span')
			const otherTooltip = findElementByClass(dom.document.body, 'other-tooltip')
			if (focusableTooltip?.dispatchEvent === undefined || otherTooltip?.dispatchEvent === undefined) throw new Error('tooltip targets were not rendered')
			await act(() => { focusableTooltip.dispatchEvent?.(new Event('focusin', { bubbles: true })) })
			assert.equal(findElementByClass(dom.document.body, 'preact-hint__content')?.textContent, 'Focused explanation')
			// The pointer also moves onto the element, starting its delayed hover tooltip.
			await act(() => { focusableTooltip.dispatchEvent?.(new Event('mouseover', { bubbles: true })) })

			// Like Firefox, the DOM mock fires no focusout when the focused element is removed.
			await act(async () => {
				renderTooltips(false)
				await Promise.resolve()
			})
			assert.equal(findElement(dom.document.body, 'span'), undefined)
			assert.equal(findElementByClass(dom.document.body, 'preact-hint__content'), undefined)

			// The hover tooltip that was pending when the element was removed does not bring it back.
			await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)) })
			assert.equal(findElementByClass(dom.document.body, 'preact-hint__content'), undefined)

			await act(() => { otherTooltip.dispatchEvent?.(new Event('mouseout', { bubbles: true })) })
			assert.equal(findElementByClass(dom.document.body, 'preact-hint__content'), undefined)
		} finally {
			render(null, dom.document.body)
			dom.restore()
		}
	})

	test('keeps a newer copy message when the focused element is removed', async () => {
		const dom = installDomMock()
		try {
			const renderTooltips = (isFocusableTooltipShown: boolean) => render(<Hint>
				{ isFocusableTooltipShown ? <span data-tooltip = 'Focused explanation' tabIndex = { 0 }>Warning</span> : <></> }
				<div class = 'copy-target'>Copy</div>
			</Hint>, dom.document.body)
			await act(() => { renderTooltips(true) })
			const focusableTooltip = findElement(dom.document.body, 'span')
			const copyTarget = findElementByClass(dom.document.body, 'copy-target')
			if (focusableTooltip?.dispatchEvent === undefined || copyTarget?.dispatchEvent === undefined) throw new Error('hint targets were not rendered')
			await act(() => { focusableTooltip.dispatchEvent?.(new Event('focusin', { bubbles: true })) })
			await act(() => { showHint(copyTarget, { content: 'Copied', delay: 60_000, x: 0, y: 0 }) })

			await act(async () => {
				renderTooltips(false)
				await Promise.resolve()
			})
			assert.equal(findElementByClass(dom.document.body, 'preact-hint__content')?.textContent, 'Copied')
		} finally {
			render(null, dom.document.body)
			dom.restore()
		}
	})

	const renderAndFocusTooltipWhileCopyMessageIsPending = async (dom: ReturnType<typeof installDomMock>, copyMessageDelay: number) => {
		await act(() => {
			render(<Hint><span data-tooltip = 'Focused explanation' tabIndex = { 0 }>Warning</span></Hint>, dom.document.body)
		})
		const focusableTooltip = findElement(dom.document.body, 'span')
		if (focusableTooltip?.dispatchEvent === undefined) throw new Error('tooltip target was not rendered')
		await act(() => { showHint(focusableTooltip, { content: 'Copied', delay: copyMessageDelay, x: 0, y: 0 }) })
		assert.equal(findElementByClass(dom.document.body, 'preact-hint__content')?.textContent, 'Copied')
		await act(() => { focusableTooltip.dispatchEvent?.(new Event('focusin', { bubbles: true })) })
		return focusableTooltip
	}

	test('keeps a focused tooltip after the replaced copy message timer would have fired', async () => {
		const dom = installDomMock()
		try {
			await renderAndFocusTooltipWhileCopyMessageIsPending(dom, 20)
			await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)) })
			assert.equal(findElementByClass(dom.document.body, 'preact-hint__content')?.textContent, 'Focused explanation')
		} finally {
			render(null, dom.document.body)
			dom.restore()
		}
	})

	test('hides a focused tooltip on focusout even if a copy message was pending when focus arrived', async () => {
		const dom = installDomMock()
		try {
			const focusableTooltip = await renderAndFocusTooltipWhileCopyMessageIsPending(dom, 60_000)
			assert.equal(findElementByClass(dom.document.body, 'preact-hint__content')?.textContent, 'Focused explanation')
			await act(() => { focusableTooltip.dispatchEvent?.(new Event('focusout', { bubbles: true })) })
			assert.equal(findElementByClass(dom.document.body, 'preact-hint__content'), undefined)
		} finally {
			render(null, dom.document.body)
			dom.restore()
		}
	})

	test('keeps wrapped hints narrower than the viewport by the positioning padding on both sides', async () => {
		const dom = installDomMock()
		try {
			await act(() => {
				render(<Hint><span>Hint target</span></Hint>, dom.document.body)
			})
			const hintTarget = findElement(dom.document.body, 'span')
			if (hintTarget?.dispatchEvent === undefined) throw new Error('hint target was not rendered')

			await act(() => { showHint(hintTarget, { content: 'A long explanation that wraps', delay: 60_000, x: 0, y: 0 }) })
			assert.equal(findElementByClass(dom.document.body, 'preact-hint')?.style?.['maxWidth'], 'calc(100% - 60px)')
		} finally {
			render(null, dom.document.body)
			dom.restore()
		}
	})
})
