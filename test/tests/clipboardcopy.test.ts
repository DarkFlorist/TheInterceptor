import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { CopyToClipboard, copyToClipboard } from '../../app/ts/components/subcomponents/CopyToClipboard.js'
import { copyExecCommand } from '../../app/ts/components/subcomponents/clipboardcopy.js'
import { installDomMock } from './domMock.js'

describe('clipboard copying', () => {
	test('reports success only after text has been resolved and copied', async () => {
		const copiedTexts: string[] = []
		const copy = async (text: string) => { copiedTexts.push(text) }
		assert.equal(await copyToClipboard({ content: 'direct' }, copy), true)
		assert.equal(await copyToClipboard({ copyFunction: async () => 'resolved' }, copy), true)
		assert.equal(await copyToClipboard({ copyFunction: async () => undefined }, copy), false)
		assert.deepEqual(copiedTexts, ['direct', 'resolved'])
		await assert.rejects(copyToClipboard({ content: 'failed' }, async () => { throw new Error('copy failed') }), /copy failed/u)
	})

	test('the component dispatches feedback only after async copy completion', async () => {
		const previousNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
		const previousSelectionDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'getSelection')
		Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async () => undefined } } })
		let resolveText = (_text: string | undefined) => undefined
		const pendingText = new Promise<string | undefined>((resolve) => { resolveText = resolve })
		const dispatchedEvents: Event[] = []
		const target = { dispatchEvent: (event: Event) => { dispatchedEvents.push(event); return true } }
		try {
			const component = CopyToClipboard({ copyFunction: async () => await pendingText, children: 'Copy' })
			assert.equal(component.props.children.props['data-hint'], undefined)
			const clickPromise = component.props.onClick({ currentTarget: target, clientX: 12, clientY: 34 })
			await Promise.resolve()
			assert.deepEqual(dispatchedEvents, [])
			resolveText('resolved')
			await clickPromise
			assert.equal(dispatchedEvents.length, 1)
			const successEvent = dispatchedEvents[0]
			if (!(successEvent instanceof CustomEvent)) throw new Error('expected copy feedback event')
			assert.deepEqual(successEvent.detail, { content: 'Copied to clipboard!', delay: 1500, x: 12, y: 34 })

			const unexpectedFailureComponent = CopyToClipboard({ copyFunction: async () => { throw new Error('failed') }, children: 'Copy' })
			await assert.rejects(unexpectedFailureComponent.props.onClick({ currentTarget: target, clientX: 1, clientY: 2 }), /failed/u)
			assert.equal(dispatchedEvents.length, 1)

			Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async () => { throw new DOMException('denied', 'NotAllowedError') } } } })
			Object.defineProperty(globalThis, 'getSelection', { configurable: true, value: () => undefined })
			const deniedComponent = CopyToClipboard({ content: 'denied', children: 'Copy' })
			await deniedComponent.props.onClick({ currentTarget: target, clientX: 1, clientY: 2 })
			const failureEvent = dispatchedEvents[1]
			if (!(failureEvent instanceof CustomEvent)) throw new Error('expected copy failure feedback event')
			assert.deepEqual(failureEvent.detail, { content: 'Could not copy to clipboard.', delay: 1500, x: 1, y: 2 })
		} finally {
			if (previousNavigatorDescriptor === undefined) delete globalThis.navigator
			else Object.defineProperty(globalThis, 'navigator', previousNavigatorDescriptor)
			if (previousSelectionDescriptor === undefined) delete globalThis.getSelection
			else Object.defineProperty(globalThis, 'getSelection', previousSelectionDescriptor)
		}
	})

	test('fails before appending a fallback element when no selection is available', async () => {
		const previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'getSelection')
		Object.defineProperty(globalThis, 'getSelection', { configurable: true, value: () => undefined })
		try {
			await assert.rejects(copyExecCommand('text'), /The request is not allowed/u)
		} finally {
			if (previousDescriptor === undefined) delete globalThis.getSelection
			else Object.defineProperty(globalThis, 'getSelection', previousDescriptor)
		}
	})

	test('removes the fallback element when range setup fails after append', async () => {
		const dom = installDomMock()
		const previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'getSelection')
		let selectionCleanupCount = 0
		Object.defineProperty(globalThis, 'getSelection', {
			configurable: true,
			value: () => ({ removeAllRanges: () => { selectionCleanupCount += 1 } }),
		})
		try {
			await assert.rejects(copyExecCommand('sensitive text'), /createRange/u)
			assert.equal(dom.document.body.textContent, '')
			assert.equal(dom.document.body.childNodes.length, 0)
			assert.equal(selectionCleanupCount, 1)
		} finally {
			if (previousDescriptor === undefined) delete globalThis.getSelection
			else Object.defineProperty(globalThis, 'getSelection', previousDescriptor)
			dom.restore()
		}
	})
})
