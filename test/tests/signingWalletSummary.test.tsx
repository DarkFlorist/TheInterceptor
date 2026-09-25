import { expect, test } from 'bun:test'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { SigningWalletSummary } from '../../app/ts/components/subcomponents/SigningWalletSummary.js'
import { findRenderedElement, installDomMock } from './domMock.js'

for (const failed of [false, true]) test(`wallet summary distinguishes loading from ${ failed ? 'a failed lookup' : 'an unbound address' }`, async () => {
	const dom = installDomMock()
	const previousBrowser = Object.getOwnPropertyDescriptor(globalThis, 'browser')
	let reply: (value: unknown) => void = () => { throw new Error('Reply not initialized') }
	const pending = new Promise<unknown>((resolve) => { reply = resolve })
	Object.defineProperty(globalThis, 'browser', { configurable: true, value: { runtime: { sendMessage: async () => pending } } })
	try {
		await act(async () => { render(h(SigningWalletSummary, { address: 1n }), dom.document.body) })
		expect(dom.document.body.textContent).toContain('Loading signing wallet')
		expect(dom.document.body.textContent).not.toContain('No signing wallet')
		expect(findRenderedElement(dom.document.body, (node) => String(node.attributes?.['aria-busy']) === 'true')).toBeDefined()
		await act(async () => { reply(failed ? { ok: false, message: 'Wallet lookup failed' } : { ok: true, bindings: [] }); await pending; await new Promise((resolve) => setTimeout(resolve, 0)) })
		expect(dom.document.body.textContent).toContain(failed ? 'Wallet lookup failed' : 'No signing wallet')
		expect(dom.document.body.textContent).not.toContain('Loading signing wallet')
		if (failed) expect(dom.document.body.textContent).not.toContain('No signing wallet')
	} finally {
		act(() => { render(undefined, dom.document.body) })
		if (previousBrowser === undefined) Reflect.deleteProperty(globalThis, 'browser')
		else Object.defineProperty(globalThis, 'browser', previousBrowser)
		dom.restore()
	}
})
