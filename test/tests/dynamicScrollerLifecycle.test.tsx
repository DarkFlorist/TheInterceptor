import * as assert from 'node:assert'
import { signal } from '@preact/signals'
import { describe, test } from 'bun:test'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { DynamicScroller } from '../../app/ts/components/subcomponents/DynamicScroller.js'
import { installDomMock } from './domMock.js'
import { collectElements } from './domQueries.js'
import { replaceGlobal } from '../harness/globals.js'

type ObservedSize = { readonly contentRect: { readonly height: number } }

// A ResizeObserver replacement that reports one fixed content height as soon as an element is observed; the app constructs it with `new`, so it is a plain function that returns the observer.
function createFixedHeightResizeObserver(height: number) {
	return function FixedHeightResizeObserver(callback: (entries: readonly ObservedSize[], observer: unknown) => void) {
		const observer = {
			observe: () => { callback([{ contentRect: { height } }], observer) },
			disconnect: () => undefined,
		}
		return observer
	}
}

describe('DynamicScroller lifecycle', () => {
	test('does not restore a stale index when a shrunken list grows again', async () => {
		const dom = installDomMock()
		const restoreResizeObserver = replaceGlobal('ResizeObserver', createFixedHeightResizeObserver(160))
		const items = signal<Readonly<number[]>>([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
		try {
			await act(() => {
				render(<DynamicScroller items = { items } renderItem = { (item) => item.toString() } />, dom.document.body)
			})
			const scrollView = collectElements(dom.document.body, 'div')[0]
			assert.ok(scrollView !== undefined, 'scroll view was not rendered')
			scrollView.scrollTop = 240
			await act(() => { scrollView.dispatchEvent(new Event('scroll')) })
			assert.equal(dom.document.body.textContent, '6789')

			await act(() => { items.value = [0, 1] })
			assert.equal(dom.document.body.textContent, '01')
			await act(() => { items.value = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] })
			assert.equal(dom.document.body.textContent, '01234')
			assert.equal(scrollView.scrollTop, 0)
		} finally {
			render(undefined, dom.document.body)
			dom.restore()
			restoreResizeObserver()
		}
	})
})
