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
	readonly style?: { getPropertyValue: (name: string) => string }
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
		const observers: TestResizeObserver[] = []
		class TestResizeObserver {
			readonly callback: ResizeObserverCallback
			target: Element | undefined
			constructor(callback: ResizeObserverCallback) {
				this.callback = callback
				observers.push(this)
			}
			observe(target: Element) {
				this.target = target
				const height = target instanceof HTMLDivElement && target.style.overflowY === 'scroll' ? 160 : 40
				this.resize(height)
			}
			resize(height: number) { this.callback([{ contentRect: { height } }], this) }
			disconnect() { this.target = undefined }
		}
		Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: TestResizeObserver })
		const items = signal<Readonly<number[]>>([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
		try {
			await act(() => {
				render(<DynamicScroller items = { items } renderItem = { (item) => item.toString() } />, dom.document.body)
			})
			const scrollView = findElement(dom.document.body, 'div')
			if (scrollView?.dispatchEvent === undefined) throw new Error('scroll view was not rendered')
			const scrollContent = scrollView.childNodes?.[0]
			const translation = () => Number.parseFloat(scrollContent?.style?.getPropertyValue('--virtual-scroll-offset') ?? '0')
			let scrollTop = 0
			Object.defineProperty(scrollView, 'scrollTop', {
				configurable: true,
				get: () => scrollTop,
				set: (value: number) => {
					const spacerHeight = Number.parseFloat(scrollContent?.style?.getPropertyValue('height') ?? '0')
					scrollTop = Math.max(0, Math.min(value, spacerHeight - 160))
				},
			})
			scrollView.scrollTop = 230
			await act(() => { scrollView.dispatchEvent?.(new Event('scroll')) })
			assert.equal(dom.document.body.textContent, '56789')
			assert.equal(translation() - scrollView.scrollTop, -30)
			const visibleRowObserver = observers.find((observer) => observer.target !== undefined && observer.target !== scrollView)
			assert.equal(visibleRowObserver?.target?.textContent, '5')
			await act(() => { visibleRowObserver?.resize(80) })
			assert.equal(dom.document.body.textContent, '567')
			assert.equal(scrollView.scrollTop, 430)
			assert.equal(translation() - scrollView.scrollTop, -30)
			await act(() => { visibleRowObserver?.resize(40) })
			assert.equal(dom.document.body.textContent, '567')
			assert.equal(translation() - scrollView.scrollTop, -30)

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
