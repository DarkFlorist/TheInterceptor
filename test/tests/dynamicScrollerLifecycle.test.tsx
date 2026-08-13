import * as assert from 'assert'
import { signal } from '@preact/signals'
import { describe, test } from 'bun:test'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { DynamicScroller } from '../../app/ts/components/subcomponents/DynamicScroller.js'
import { installDomMock } from './domMock.js'

type TestNode = {
	readonly childNodes?: readonly TestNode[]
	readonly dispatchEvent?: (event: Event) => boolean
	readonly tagName?: string
	scrollTop?: number
}

function findElement(node: TestNode | undefined, tagName: string): TestNode | undefined {
	if (node?.tagName === tagName.toUpperCase()) return node
	for (const child of node?.childNodes ?? []) {
		const match = findElement(child, tagName)
		if (match !== undefined) return match
	}
	return undefined
}

describe('DynamicScroller lifecycle', () => {
	test('does not restore a stale index when a shrunken list grows again', async () => {
		const dom = installDomMock()
		const previousResizeObserverDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver')
		class TestResizeObserver {
			readonly callback: ResizeObserverCallback
			constructor(callback: ResizeObserverCallback) { this.callback = callback }
			observe() { this.callback([{ contentRect: { height: 160 } }], this) }
			disconnect() { return undefined }
		}
		Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: TestResizeObserver })
		const items = signal<Readonly<number[]>>([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
		try {
			await act(() => {
				render(<DynamicScroller items = { items } renderItem = { (item) => item.toString() } />, dom.document.body)
			})
			const scrollView = findElement(dom.document.body, 'div')
			if (scrollView?.dispatchEvent === undefined) throw new Error('scroll view was not rendered')
			scrollView.scrollTop = 240
			await act(() => { scrollView.dispatchEvent?.(new Event('scroll')) })
			assert.equal(dom.document.body.textContent, '6789')

			await act(() => { items.value = [0, 1] })
			assert.equal(dom.document.body.textContent, '01')
			await act(() => { items.value = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] })
			assert.equal(dom.document.body.textContent, '01234')
			assert.equal(scrollView.scrollTop, 0)
		} finally {
			render(null, dom.document.body)
			dom.restore()
			if (previousResizeObserverDescriptor === undefined) delete globalThis.ResizeObserver
			else Object.defineProperty(globalThis, 'ResizeObserver', previousResizeObserverDescriptor)
		}
	})
})
