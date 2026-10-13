import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { AsyncActionButton } from '../../app/ts/components/subcomponents/AsyncAction.js'
import { installDomMock } from './domMock.js'
import { collectElements, findElementByClass, getElementByClass } from './domQueries.js'

describe('AsyncActionButton', () => {
	test('passes accessible labels and titles to the button', async () => {
		const dom = installDomMock()
		try {
			await act(() => {
				render(h(AsyncActionButton, {
					state: 'inactive',
					text: 'Clear stack',
					pendingText: 'Clearing stack...',
					onClick: () => undefined,
					ariaLabel: 'Clear simulation stack',
					pendingAriaLabel: 'Clearing simulation stack...',
					title: 'Clear simulation stack',
				}), dom.document.body)
			})

			const button = collectElements(dom.document.body, 'button')[0]
			assert.equal(button?.getAttribute('aria-label'), 'Clear simulation stack')
			assert.equal(button?.getAttribute('title'), 'Clear simulation stack')

			await act(() => {
				render(h(AsyncActionButton, {
					state: 'pending',
					text: 'Clear stack',
					pendingText: 'Clearing stack...',
					onClick: () => undefined,
					ariaLabel: 'Clear simulation stack',
					pendingAriaLabel: 'Clearing simulation stack...',
				}), dom.document.body)
			})
			assert.equal(collectElements(dom.document.body, 'button')[0]?.getAttribute('aria-label'), 'Clearing simulation stack...')
		} finally {
			render(undefined, dom.document.body)
			dom.restore()
		}
	})

	test('keeps the pending indicator outside the original text layout', async () => {
		const dom = installDomMock()
		try {
			await act(() => {
				render(h(AsyncActionButton, {
					state: 'inactive',
					text: 'Simulating',
					pendingText: 'Switching to simulating mode...',
					keepTextWhilePending: true,
					pendingIndicatorPlacement: 'overlay',
					onClick: () => undefined,
				}), dom.document.body)
			})

			const inactiveContent = getElementByClass(dom.document.body, 'async-action-button__stable-content')
			const inactiveSlot = getElementByClass(dom.document.body, 'async-action-button__status-slot')
			assert.equal(inactiveContent.style.getPropertyValue('position'), 'relative')
			assert.equal(inactiveSlot.style.getPropertyValue('position'), 'absolute')
			assert.equal(inactiveSlot.style.getPropertyValue('right'), 'calc(100% + 0.125em)')
			assert.equal(inactiveSlot.style.getPropertyValue('width'), '0.75em')
			assert.equal(inactiveSlot.style.getPropertyValue('visibility'), 'hidden')
			assert.equal(collectElements(inactiveSlot, 'svg').length, 0)
			assert.equal(inactiveContent.textContent, 'Simulating')

			await act(() => {
				render(h(AsyncActionButton, {
					state: 'pending',
					text: 'Simulating',
					pendingText: 'Switching to simulating mode...',
					keepTextWhilePending: true,
					pendingIndicatorPlacement: 'overlay',
					onClick: () => undefined,
				}), dom.document.body)
			})

			const pendingContent = getElementByClass(dom.document.body, 'async-action-button__stable-content')
			const pendingSlot = getElementByClass(dom.document.body, 'async-action-button__status-slot')
			assert.equal(pendingSlot.style.getPropertyValue('position'), 'absolute')
			assert.equal(pendingSlot.style.getPropertyValue('right'), 'calc(100% + 0.125em)')
			assert.equal(pendingSlot.style.getPropertyValue('width'), '0.75em')
			assert.equal(pendingSlot.style.getPropertyValue('visibility'), 'visible')
			assert.equal(collectElements(pendingSlot, 'svg').length, 1)
			assert.equal(pendingContent.textContent, 'Simulating')
		} finally {
			render(undefined, dom.document.body)
			dom.restore()
		}
	})

	test('selects pending text independently from indicator placement', async () => {
		const dom = installDomMock()
		try {
			await act(() => {
				render(h(AsyncActionButton, {
					state: 'pending',
					text: 'Import',
					pendingText: 'Importing...',
					pendingIndicatorPlacement: 'overlay',
					onClick: () => undefined,
				}), dom.document.body)
			})

			assert.equal(getElementByClass(dom.document.body, 'async-action-button__stable-content').textContent, 'Importing...')
			assert.equal(getElementByClass(dom.document.body, 'async-action-button__status-slot').style.getPropertyValue('position'), 'absolute')

			await act(() => {
				render(h(AsyncActionButton, {
					state: 'pending',
					text: 'Simulating',
					pendingText: 'Switching to simulating mode...',
					keepTextWhilePending: true,
					onClick: () => undefined,
				}), dom.document.body)
			})

			assert.equal(getElementByClass(dom.document.body, 'async-action-button__inline-content').textContent, 'Simulating')
			assert.equal(findElementByClass(dom.document.body, 'async-action-button__status-slot'), undefined)
		} finally {
			render(undefined, dom.document.body)
			dom.restore()
		}
	})
})
