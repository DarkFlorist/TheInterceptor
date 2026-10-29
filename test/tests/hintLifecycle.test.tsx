import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import Hint, { calculateHintPosition, showHint } from '../../app/ts/components/subcomponents/Hint.js'
import { installDomMock } from './domMock.js'

type TestNode = {
	readonly childNodes?: readonly TestNode[]
	readonly dispatchEvent?: (event: Event) => boolean
	readonly focus?: () => void
	readonly blur?: () => void
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

const findDisplayedHintText = (dom: ReturnType<typeof installDomMock>) => findElementByClass(dom.document.body, 'preact-hint__content')?.textContent

const setBoundingClientRect = (element: TestNode, bounds: { left: number, top: number, width: number, height: number }) => {
	Object.defineProperty(element, 'getBoundingClientRect', { configurable: true, value: () => ({ ...bounds, right: bounds.left + bounds.width, bottom: bounds.top + bounds.height, x: bounds.left, y: bounds.top }) })
}

// Bun has no viewport, so positioning tests define the one Hint places hints within and restore the previous globals afterwards.
function installViewportSize(width: number, height: number) {
	const previousWidth = Object.getOwnPropertyDescriptor(globalThis, 'innerWidth')
	const previousHeight = Object.getOwnPropertyDescriptor(globalThis, 'innerHeight')
	Object.defineProperty(globalThis, 'innerWidth', { configurable: true, writable: true, value: width })
	Object.defineProperty(globalThis, 'innerHeight', { configurable: true, writable: true, value: height })
	const restoreProperty = (name: string, previousDescriptor: PropertyDescriptor | undefined) => {
		if (previousDescriptor === undefined) Reflect.deleteProperty(globalThis, name)
		else Object.defineProperty(globalThis, name, previousDescriptor)
	}
	return () => {
		restoreProperty('innerWidth', previousWidth)
		restoreProperty('innerHeight', previousHeight)
	}
}

describe('calculateHintPosition', () => {
	const viewportSize = { width: 400, height: 600 }
	const hintSize = { width: 100, height: 40 }

	test('places the hint below its anchor when it fits there', () => {
		assert.deepEqual(calculateHintPosition({ x: 200, top: 100, bottom: 116 }, hintSize, viewportSize), { left: 150, top: 126 })
	})

	test('places the hint above its anchor when the viewport has no room below it', () => {
		// Below a warning whose bottom is at 596 pixels, the hint would start at 606 pixels, outside the 600 pixel viewport.
		assert.deepEqual(calculateHintPosition({ x: 200, top: 580, bottom: 596 }, hintSize, viewportSize), { left: 150, top: 530 })
		assert.deepEqual(calculateHintPosition({ x: 200, top: 560, bottom: 560 }, hintSize, viewportSize), { left: 150, top: 510 })
	})

	test('keeps the hint within the viewport border padding when neither side of its anchor fits it', () => {
		assert.deepEqual(calculateHintPosition({ x: 200, top: 200, bottom: 216 }, { width: 100, height: 500 }, viewportSize), { left: 150, top: 70 })
		assert.deepEqual(calculateHintPosition({ x: 200, top: 200, bottom: 216 }, { width: 100, height: 700 }, viewportSize), { left: 150, top: 30 })
	})

	test('clamps the hint horizontally within the viewport border padding', () => {
		assert.deepEqual(calculateHintPosition({ x: 390, top: 100, bottom: 100 }, hintSize, viewportSize), { left: 270, top: 110 })
		assert.deepEqual(calculateHintPosition({ x: 10, top: 100, bottom: 100 }, hintSize, viewportSize), { left: 30, top: 110 })
	})
})

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

	test('keeps the tooltip of the focused element when the pointer leaves it or another tooltip', async () => {
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

			await act(() => {
				focusableTooltip.focus?.()
				focusableTooltip.dispatchEvent?.(new Event('focusin', { bubbles: true }))
			})
			await act(() => { focusableTooltip.dispatchEvent?.(new Event('mouseout', { bubbles: true })) })
			assert.equal(findElementByClass(dom.document.body, 'preact-hint__content')?.textContent, 'Focused explanation')

			await act(() => { otherTooltip.dispatchEvent?.(new Event('mouseout', { bubbles: true })) })
			assert.equal(findElementByClass(dom.document.body, 'preact-hint__content')?.textContent, 'Focused explanation')

			await act(() => {
				focusableTooltip.blur?.()
				focusableTooltip.dispatchEvent?.(new Event('focusout', { bubbles: true }))
			})
			assert.equal(findElementByClass(dom.document.body, 'preact-hint__content'), undefined)
			await act(() => { otherTooltip.dispatchEvent?.(new Event('mouseout', { bubbles: true })) })
			assert.equal(findElementByClass(dom.document.body, 'preact-hint__content'), undefined)
		} finally {
			render(null, dom.document.body)
			dom.restore()
		}
	})

	test('does not show the tooltip of a focused or hovered element after it is removed', async () => {
		const dom = installDomMock()
		try {
			const renderTooltips = (isRemovableTooltipShown: boolean) => render(<Hint>
				{ isRemovableTooltipShown ? <span class = 'removable-tooltip' data-tooltip = 'Removed explanation' tabIndex = { 0 }>Warning</span> : <></> }
				<div class = 'other-tooltip' data-tooltip = 'Hovered tooltip'>Other</div>
			</Hint>, dom.document.body)
			const otherTooltip = () => findElementByClass(dom.document.body, 'other-tooltip')
			const removableTooltip = () => findElementByClass(dom.document.body, 'removable-tooltip')

			// Hovered: the delayed tooltip of an element removed before it appears never appears, since the removal fires no mouseout.
			await act(() => { renderTooltips(true) })
			await act(() => { removableTooltip()?.dispatchEvent?.(new Event('mouseover', { bubbles: true })) })
			await act(() => { renderTooltips(false) })
			await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)) })
			assert.equal(findElementByClass(dom.document.body, 'preact-hint__content'), undefined)

			// Focused: the removal fires no focusout, and the DOM mock keeps the removed element as the active element. Leaving another tooltip then clears the tooltip instead of falling back to the removed element.
			await act(() => { renderTooltips(true) })
			await act(() => {
				removableTooltip()?.focus?.()
				removableTooltip()?.dispatchEvent?.(new Event('focusin', { bubbles: true }))
			})
			assert.equal(findElementByClass(dom.document.body, 'preact-hint__content')?.textContent, 'Removed explanation')
			await act(() => { renderTooltips(false) })
			assert.equal(removableTooltip(), undefined)
			await act(() => { otherTooltip()?.dispatchEvent?.(new Event('mouseout', { bubbles: true })) })
			assert.equal(findElementByClass(dom.document.body, 'preact-hint__content'), undefined)
		} finally {
			render(null, dom.document.body)
			dom.restore()
		}
	})

	for (const eventType of ['focusin', 'focusout', 'mouseover', 'mouseout', 'click']) {
		test(`dismisses the tooltip of a removed focused element on the next ${ eventType } in the container`, async () => {
			const dom = installDomMock()
			try {
				const renderTooltips = (isRemovableTooltipShown: boolean) => render(<Hint>
					{ isRemovableTooltipShown ? <span class = 'removable-tooltip' data-tooltip = 'Removed explanation' tabIndex = { 0 }>Warning</span> : <></> }
					<button class = 'plain-control'>Plain control</button>
				</Hint>, dom.document.body)
				await act(() => { renderTooltips(true) })
				await act(() => {
					const removableTooltip = findElementByClass(dom.document.body, 'removable-tooltip')
					removableTooltip?.focus?.()
					removableTooltip?.dispatchEvent?.(new Event('focusin', { bubbles: true }))
				})
				await act(() => { renderTooltips(false) })
				// The removal itself fires no event, so the tooltip stays until Hint sees the next event, even one on a control without a tooltip.
				assert.equal(findDisplayedHintText(dom), 'Removed explanation')
				await act(() => { findElementByClass(dom.document.body, 'plain-control')?.dispatchEvent?.(new Event(eventType, { bubbles: true })) })
				assert.equal(findDisplayedHintText(dom), undefined)
			} finally {
				render(null, dom.document.body)
				dom.restore()
			}
		})
	}

	test('dismisses the tooltip of a removed hovered element on the next pointer event in the container', async () => {
		const dom = installDomMock()
		try {
			const renderTooltips = (isRemovableTooltipShown: boolean) => render(<Hint>
				{ isRemovableTooltipShown ? <span class = 'removable-tooltip' data-tooltip = 'Removed explanation'>Hovered</span> : <></> }
				<button class = 'plain-control'>Plain control</button>
			</Hint>, dom.document.body)
			await act(() => { renderTooltips(true) })
			await act(() => { findElementByClass(dom.document.body, 'removable-tooltip')?.dispatchEvent?.(new Event('mouseover', { bubbles: true })) })
			await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)) })
			assert.equal(findDisplayedHintText(dom), 'Removed explanation')
			await act(() => { renderTooltips(false) })
			assert.equal(findDisplayedHintText(dom), 'Removed explanation')
			await act(() => { findElementByClass(dom.document.body, 'plain-control')?.dispatchEvent?.(new Event('mouseover', { bubbles: true })) })
			assert.equal(findDisplayedHintText(dom), undefined)
		} finally {
			render(null, dom.document.body)
			dom.restore()
		}
	})

	test('dismisses the tooltip of a focused element whose node Preact reuses for content without that tooltip', async () => {
		const dom = installDomMock()
		try {
			const renderTooltips = (isWarningShown: boolean) => render(<Hint>
				{ isWarningShown ? <span class = 'warning' data-tooltip = 'Removed explanation' tabIndex = { 0 }>Warning</span> : <></> }
				<span class = 'label'>Label</span>
				<button class = 'plain-control'>Plain control</button>
			</Hint>, dom.document.body)
			await act(() => { renderTooltips(true) })
			const warning = findElementByClass(dom.document.body, 'warning')
			await act(() => {
				warning?.focus?.()
				warning?.dispatchEvent?.(new Event('focusin', { bubbles: true }))
			})
			// The pointer also moves onto the warning, starting its delayed hover tooltip.
			await act(() => { warning?.dispatchEvent?.(new Event('mouseover', { bubbles: true })) })
			await act(() => { renderTooltips(false) })
			// Like the leading warning sign of a card, the removed warning is followed by a sibling of the same tag, so Preact keeps the focused node in the container as the label.
			assert.equal(findElementByClass(dom.document.body, 'label'), warning)
			assert.equal(findDisplayedHintText(dom), 'Removed explanation')
			await act(() => { findElementByClass(dom.document.body, 'plain-control')?.dispatchEvent?.(new Event('focusin', { bubbles: true })) })
			assert.equal(findDisplayedHintText(dom), undefined)
			// The hover tooltip that was pending for the reused node does not bring the explanation back.
			await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)) })
			assert.equal(findDisplayedHintText(dom), undefined)
		} finally {
			render(null, dom.document.body)
			dom.restore()
		}
	})

	test('keeps a copy message until its own timer ends when the element of an earlier tooltip is removed', async () => {
		const dom = installDomMock()
		try {
			const renderTooltips = (isRemovableTooltipShown: boolean) => render(<Hint>
				{ isRemovableTooltipShown ? <span class = 'removable-tooltip' data-tooltip = 'Removed explanation' tabIndex = { 0 }>Warning</span> : <></> }
				<button class = 'plain-control'>Plain control</button>
			</Hint>, dom.document.body)
			await act(() => { renderTooltips(true) })
			await act(() => {
				const removableTooltip = findElementByClass(dom.document.body, 'removable-tooltip')
				removableTooltip?.focus?.()
				removableTooltip?.dispatchEvent?.(new Event('focusin', { bubbles: true }))
			})
			const plainControl = findElementByClass(dom.document.body, 'plain-control')
			if (plainControl?.dispatchEvent === undefined) throw new Error('plain control was not rendered')
			await act(() => { showHint(plainControl, { content: 'Copied', delay: 30, x: 0, y: 0 }) })
			await act(() => { renderTooltips(false) })
			await act(() => { plainControl.dispatchEvent?.(new Event('focusin', { bubbles: true })) })
			assert.equal(findDisplayedHintText(dom), 'Copied')
			await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)) })
			assert.equal(findDisplayedHintText(dom), undefined)
		} finally {
			render(null, dom.document.body)
			dom.restore()
		}
	})

	test('opens the tooltip of a focused element above it when the viewport has no room below it', async () => {
		const dom = installDomMock()
		const restoreViewportSize = installViewportSize(400, 600)
		try {
			await act(() => {
				render(<Hint><span data-tooltip = 'Focused explanation' tabIndex = { 0 }>Warning</span></Hint>, dom.document.body)
			})
			const focusableTooltip = findElement(dom.document.body, 'span')
			if (focusableTooltip?.dispatchEvent === undefined) throw new Error('tooltip target was not rendered')
			// The DOM mock measures every hint as 100 by 40 pixels, so below this warning the hint would start at 606 pixels, outside the 600 pixel viewport.
			setBoundingClientRect(focusableTooltip, { left: 192, top: 580, width: 16, height: 16 })

			await act(() => { focusableTooltip.dispatchEvent?.(new Event('focusin', { bubbles: true })) })
			const hintStyle = findElementByClass(dom.document.body, 'preact-hint')?.style
			assert.equal(hintStyle?.['top'], '530px')
			assert.equal(hintStyle?.['left'], '150px')
		} finally {
			render(null, dom.document.body)
			dom.restore()
			restoreViewportSize()
		}
	})

	test('places a hint whose text changes while it is shown by the size of its new text', async () => {
		const dom = installDomMock()
		const restoreViewportSize = installViewportSize(400, 600)
		try {
			// The focused explanation renders 200 pixels tall and every other text 40 pixels, so placing the explanation by the size of the copy message shown before it would put it below the warning, where it does not fit.
			Object.defineProperty(globalThis.Element.prototype, 'getBoundingClientRect', {
				configurable: true,
				value: function (this: TestNode) {
					const height = this.textContent === 'Focused explanation' ? 200 : 40
					return { left: 0, top: 0, width: 100, height, right: 100, bottom: height, x: 0, y: 0 }
				},
			})
			await act(() => {
				render(<Hint><span data-tooltip = 'Focused explanation' tabIndex = { 0 }>Warning</span></Hint>, dom.document.body)
			})
			const focusableTooltip = findElement(dom.document.body, 'span')
			if (focusableTooltip?.dispatchEvent === undefined) throw new Error('tooltip target was not rendered')
			setBoundingClientRect(focusableTooltip, { left: 192, top: 470, width: 16, height: 16 })

			await act(() => { showHint(focusableTooltip, { content: 'Copied', delay: 60_000, x: 200, y: 100 }) })
			assert.equal(findDisplayedHintText(dom), 'Copied')
			await act(() => { focusableTooltip.dispatchEvent?.(new Event('focusin', { bubbles: true })) })
			assert.equal(findDisplayedHintText(dom), 'Focused explanation')
			assert.equal(findElementByClass(dom.document.body, 'preact-hint')?.style?.['top'], '260px')
		} finally {
			render(null, dom.document.body)
			dom.restore()
			restoreViewportSize()
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

	const renderTooltipAndShowCopyMessage = async (dom: ReturnType<typeof installDomMock>, copyMessageDelay: number) => {
		await act(() => {
			render(<Hint><span data-tooltip = 'Hovered explanation'>Warning</span></Hint>, dom.document.body)
		})
		const hoverableTooltip = findElement(dom.document.body, 'span')
		if (hoverableTooltip?.dispatchEvent === undefined) throw new Error('tooltip target was not rendered')
		await act(() => { showHint(hoverableTooltip, { content: 'Copied', delay: copyMessageDelay, x: 0, y: 0 }) })
		assert.equal(findDisplayedHintText(dom), 'Copied')
		return hoverableTooltip
	}

	test('keeps a hovered tooltip that replaced a copy message after the copy message timer would have fired', async () => {
		const dom = installDomMock()
		try {
			// The hover tooltip appears 250 milliseconds after mouseover, before the 400 millisecond copy message timer would fire.
			const hoverableTooltip = await renderTooltipAndShowCopyMessage(dom, 400)
			await act(() => { hoverableTooltip.dispatchEvent?.(new Event('mouseover', { bubbles: true })) })
			await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)) })
			assert.equal(findDisplayedHintText(dom), 'Hovered explanation')
			await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)) })
			assert.equal(findDisplayedHintText(dom), 'Hovered explanation')
			// With the copy message timer cancelled, leaving the element ends its tooltip right away.
			await act(() => { hoverableTooltip.dispatchEvent?.(new Event('mouseout', { bubbles: true })) })
			assert.equal(findDisplayedHintText(dom), undefined)
		} finally {
			render(null, dom.document.body)
			dom.restore()
		}
	})

	test('still ends a copy message on its own timer when the pointer passes over a tooltip without opening it', async () => {
		const dom = installDomMock()
		try {
			const hoverableTooltip = await renderTooltipAndShowCopyMessage(dom, 100)
			await act(() => { hoverableTooltip.dispatchEvent?.(new Event('mouseover', { bubbles: true })) })
			await act(() => { hoverableTooltip.dispatchEvent?.(new Event('mouseout', { bubbles: true })) })
			assert.equal(findDisplayedHintText(dom), 'Copied')
			await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)) })
			assert.equal(findDisplayedHintText(dom), undefined)
		} finally {
			render(null, dom.document.body)
			dom.restore()
		}
	})

	test('opens each hint as a manual popover in the top layer before measuring it', async () => {
		const dom = installDomMock()
		try {
			// A closed popover is not rendered, so measuring the hint before opening it would place it by a zero size.
			const hintCalls: string[] = []
			Object.defineProperty(globalThis.Element.prototype, 'showPopover', { configurable: true, value: function (this: TestNode) { hintCalls.push(`open ${ this.getAttribute?.('class') }`) } })
			Object.defineProperty(globalThis.Element.prototype, 'getBoundingClientRect', {
				configurable: true,
				value: function (this: TestNode) {
					hintCalls.push(`measure ${ this.getAttribute?.('class') }`)
					return { left: 0, top: 0, width: 100, height: 40, right: 100, bottom: 40, x: 0, y: 0 }
				},
			})
			await act(() => {
				render(<Hint><span data-tooltip = 'Focused explanation' tabIndex = { 0 }>Warning</span></Hint>, dom.document.body)
			})
			await act(() => { findElement(dom.document.body, 'span')?.dispatchEvent?.(new Event('focusin', { bubbles: true })) })

			assert.equal(findElementByClass(dom.document.body, 'preact-hint')?.getAttribute?.('popover'), 'manual')
			assert.deepEqual(hintCalls.filter((call) => call.includes('preact-hint')), ['open preact-hint', 'measure preact-hint__content'])
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
