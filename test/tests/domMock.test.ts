import * as assert from 'node:assert'
import { test } from 'bun:test'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { installDateMock, installDomMock, isMockDialogElement } from './domMock.js'
import { clickElement, getButtonByText, hasAncestorWithClass, isDisabled } from './domQueries.js'

test('installDomMock restore keeps newer interleaved mock globals active', () => {
	const first = installDomMock()
	const firstSetInterval = globalThis.setInterval
	const firstClearInterval = globalThis.clearInterval
	const firstRequestAnimationFrame = globalThis.requestAnimationFrame
	const firstCancelAnimationFrame = globalThis.cancelAnimationFrame
	const firstHtmlDialogElement = globalThis.HTMLDialogElement
	const firstHtmlDivElement = globalThis.HTMLDivElement
	const firstElement = globalThis.Element

	const second = installDomMock()
	const secondSetInterval = globalThis.setInterval
	const secondClearInterval = globalThis.clearInterval
	const secondRequestAnimationFrame = globalThis.requestAnimationFrame
	const secondCancelAnimationFrame = globalThis.cancelAnimationFrame
	const secondHtmlDialogElement = globalThis.HTMLDialogElement
	const secondHtmlDivElement = globalThis.HTMLDivElement
	const secondElement = globalThis.Element

	first.restore()

	assert.equal(globalThis.document, second.document)
	assert.equal(globalThis.window?.document, second.document)
	assert.equal(globalThis.setInterval, secondSetInterval)
	assert.equal(globalThis.clearInterval, secondClearInterval)
	assert.equal(globalThis.requestAnimationFrame, secondRequestAnimationFrame)
	assert.equal(globalThis.cancelAnimationFrame, secondCancelAnimationFrame)
	assert.equal(globalThis.HTMLDialogElement, secondHtmlDialogElement)
	assert.equal(globalThis.HTMLDivElement, secondHtmlDivElement)
	assert.equal(globalThis.Element, secondElement)
	assert.equal(second.document.body instanceof globalThis.HTMLDivElement, true)
	assert.equal(second.document.body instanceof globalThis.Element, true)

	second.restore()

	assert.notEqual(globalThis.document, first.document)
	assert.notEqual(globalThis.document, second.document)
	assert.notEqual(globalThis.window?.document, first.document)
	assert.notEqual(globalThis.window?.document, second.document)
	assert.notEqual(globalThis.setInterval, firstSetInterval)
	assert.notEqual(globalThis.setInterval, secondSetInterval)
	assert.notEqual(globalThis.clearInterval, firstClearInterval)
	assert.notEqual(globalThis.clearInterval, secondClearInterval)
	assert.notEqual(globalThis.requestAnimationFrame, firstRequestAnimationFrame)
	assert.notEqual(globalThis.requestAnimationFrame, secondRequestAnimationFrame)
	assert.notEqual(globalThis.cancelAnimationFrame, firstCancelAnimationFrame)
	assert.notEqual(globalThis.cancelAnimationFrame, secondCancelAnimationFrame)
	assert.notEqual(globalThis.HTMLDialogElement, firstHtmlDialogElement)
	assert.notEqual(globalThis.HTMLDialogElement, secondHtmlDialogElement)
	assert.notEqual(globalThis.HTMLDivElement, firstHtmlDivElement)
	assert.notEqual(globalThis.HTMLDivElement, secondHtmlDivElement)
	assert.notEqual(globalThis.Element, firstElement)
	assert.notEqual(globalThis.Element, secondElement)
})

test('installDomMock stores attribute values as strings and reports missing attributes as null', () => {
	const dom = installDomMock()
	try {
		const button = dom.document.createElement('button')
		button.setAttribute('aria-busy', true)
		button.setAttribute('tabindex', 0)
		assert.equal(button.getAttribute('aria-busy'), 'true')
		assert.equal(button.getAttribute('tabindex'), '0')
		assert.equal(button.getAttribute('disabled'), null)
		button.removeAttribute('aria-busy')
		assert.equal(button.hasAttribute('aria-busy'), false)
	} finally {
		dom.restore()
	}
})

test('installDomMock element globals only match nodes created by that mock', () => {
	const first = installDomMock()
	const firstDialog = first.document.createElement('dialog')
	const second = installDomMock()
	try {
		const dialog = second.document.createElement('dialog')
		const div = second.document.createElement('div')
		assert.equal(dialog instanceof globalThis.HTMLDialogElement, true)
		assert.equal(div instanceof globalThis.HTMLDialogElement, false)
		assert.equal(div instanceof globalThis.HTMLDivElement, true)
		assert.equal(second.document.createTextNode('text') instanceof globalThis.Element, false)
		assert.equal(firstDialog instanceof globalThis.HTMLDialogElement, false)
	} finally {
		second.restore()
		first.restore()
	}
})

test('installDomMock dialogs dispatch a close event with the dialog as currentTarget', () => {
	const dom = installDomMock()
	try {
		const dialog = dom.document.createElement('dialog')
		const closeTargets: unknown[] = []
		dialog.addEventListener('close', (event) => { closeTargets.push(event.currentTarget) })
		assert.ok(isMockDialogElement(dialog))
		dialog.showModal()
		assert.equal(dialog.open, true)
		dialog.close('confirm')
		assert.equal(dialog.open, false)
		assert.equal(dialog.returnValue, 'confirm')
		assert.deepEqual(closeTargets, [dialog])
	} finally {
		dom.restore()
	}
})

test('installDateMock controls new Date() and Date.now() and restores the real Date', () => {
	const RealDate = Date
	const dateMock = installDateMock('2024-01-01T00:00:00.000Z')
	try {
		assert.equal(new Date().toISOString(), '2024-01-01T00:00:00.000Z')
		dateMock.setNow('2024-01-02T00:00:00.000Z')
		assert.equal(Date.now(), new RealDate('2024-01-02T00:00:00.000Z').getTime())
		assert.equal(new Date(0).getTime(), 0)
		assert.equal(new Date(2024, 0, 3).getFullYear(), 2024)
		assert.equal(new Date() instanceof Date, true)
	} finally {
		dateMock.restore()
	}
	assert.equal(globalThis.Date, RealDate)
})

test('domQueries find rendered elements and call their Preact click handlers', async () => {
	const dom = installDomMock()
	let clicks = 0
	try {
		await act(() => {
			render(h('div', { class: 'toolbar' }, h('button', { onClick: () => { clicks += 1 }, disabled: true }, ' Save  draft ')), dom.document.body)
		})
		const button = getButtonByText(dom.document.body, 'Save draft')
		assert.equal(isDisabled(button), true)
		assert.equal(hasAncestorWithClass(button, 'toolbar'), true)
		await clickElement(button)
		assert.equal(clicks, 1)
	} finally {
		render(undefined, dom.document.body)
		dom.restore()
	}
})
