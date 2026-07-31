import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { InterceptorDialogBody, InterceptorDialogFooter, InterceptorDialogHeader, InterceptorDialogSection, InterceptorDialogSurface } from '../../app/ts/components/subcomponents/InterceptorDialog.js'
import { installDomMock } from './domMock.js'

type TestNode = {
	readonly childNodes?: readonly TestNode[]
	readonly dispatchEvent?: (event: { bubbles?: boolean, key?: string, shiftKey?: boolean, type: string }) => boolean
	readonly focus?: () => void
	readonly getAttribute?: (name: string) => string | null
	readonly tagName?: string
	readonly textContent?: string | null
}

function findByClass(node: TestNode | undefined, className: string): TestNode | undefined {
	if (node?.getAttribute?.('class')?.split(/\s+/).includes(className)) return node
	for (const child of node?.childNodes ?? []) {
		const match = findByClass(child, className)
		if (match !== undefined) return match
	}
	return undefined
}

describe('InterceptorDialog', () => {
	test('provides a consistent accessible dialog structure', async () => {
		const dom = installDomMock()
		try {
			await act(() => {
				render(
					<InterceptorDialogSurface ariaLabel = 'Example settings' size = 'large' fill = { true }>
						<InterceptorDialogHeader close = { () => undefined } closeLabel = 'Close example settings' icon = '../img/address-book.svg' title = 'Example settings' subtitle = 'A concise explanation'/>
						<InterceptorDialogBody><InterceptorDialogSection label = 'Options'>Content</InterceptorDialogSection></InterceptorDialogBody>
						<InterceptorDialogFooter><button type = 'button'>Save</button></InterceptorDialogFooter>
					</InterceptorDialogSurface>,
					dom.document.body,
				)
			})

			const dialog = findByClass(dom.document.body, 'interceptor-dialog')
			assert.equal(dialog?.getAttribute?.('role'), 'dialog')
			assert.equal(dialog?.getAttribute?.('aria-modal'), 'true')
			assert.equal(dialog?.getAttribute?.('aria-label'), 'Example settings')
			assert.equal(dialog?.getAttribute?.('class')?.includes('interceptor-dialog--large'), true)
			assert.equal(dialog?.getAttribute?.('class')?.includes('interceptor-dialog--fill'), true)

			const header = findByClass(dialog, 'interceptor-dialog-header')
			assert.equal(findByClass(header, 'interceptor-dialog-title')?.textContent, 'Example settings')
			assert.equal(findByClass(header, 'interceptor-dialog-subtitle')?.textContent, 'A concise explanation')
			assert.equal(findByClass(header, 'interceptor-dialog-close')?.getAttribute?.('aria-label'), 'Close example settings')
			assert.equal(findByClass(dialog, 'interceptor-dialog-section')?.getAttribute?.('aria-label'), 'Options')
			assert.equal(findByClass(dialog, 'interceptor-dialog-footer')?.textContent, 'Save')
		} finally {
			render(null, dom.document.body)
			dom.restore()
		}
	})

	test('manages focus and respects the Escape close guard', async () => {
		const dom = installDomMock()
		let closeCount = 0
		const renderDialog = async (visible: boolean, closeDisabled = false) => {
			await act(() => {
				render(<>
					<button type = 'button' class = 'dialog-trigger'>Open</button>
					{ visible ? <InterceptorDialogSurface ariaLabel = 'Keyboard dialog' closeDisabled = { closeDisabled } onClose = { () => { closeCount += 1 } }><InterceptorDialogBody><button type = 'button' class = 'first-dialog-action'>First</button><button type = 'button' class = 'last-dialog-action'>Last</button></InterceptorDialogBody></InterceptorDialogSurface> : <></> }
				</>, dom.document.body)
			})
		}

		try {
			await renderDialog(false)
			const trigger = findByClass(dom.document.body, 'dialog-trigger')
			trigger?.focus?.()
			assert.equal(dom.document.activeElement, trigger)

			await renderDialog(true)
			const dialog = findByClass(dom.document.body, 'interceptor-dialog')
			assert.equal(dom.document.activeElement, dialog)
			dialog?.dispatchEvent?.({ type: 'keydown', key: 'Tab', bubbles: true })
			const firstDialogAction = findByClass(dialog, 'first-dialog-action')
			const lastDialogAction = findByClass(dialog, 'last-dialog-action')
			assert.equal(dom.document.activeElement, firstDialogAction)
			lastDialogAction?.focus?.()
			dialog?.dispatchEvent?.({ type: 'keydown', key: 'Tab', bubbles: true })
			assert.equal(dom.document.activeElement, firstDialogAction)
			firstDialogAction?.focus?.()
			dialog?.dispatchEvent?.({ type: 'keydown', key: 'Tab', shiftKey: true, bubbles: true })
			assert.equal(dom.document.activeElement, lastDialogAction)
			dialog?.dispatchEvent?.({ type: 'keydown', key: 'Escape', bubbles: true })
			assert.equal(closeCount, 1)

			await renderDialog(true, true)
			findByClass(dom.document.body, 'interceptor-dialog')?.dispatchEvent?.({ type: 'keydown', key: 'Escape', bubbles: true })
			assert.equal(closeCount, 1)

			await renderDialog(false)
			assert.equal(dom.document.activeElement, trigger)
		} finally {
			render(null, dom.document.body)
			dom.restore()
		}
	})
})
