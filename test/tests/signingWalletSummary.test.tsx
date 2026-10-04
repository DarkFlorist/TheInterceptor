import { useSigningWalletBindings } from '../../app/ts/components/hooks/useSigningWalletBindings.js'
import { expect, test } from 'bun:test'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { SigningWalletSummary } from '../../app/ts/components/subcomponents/SigningWalletSummary.js'
import { findRenderedElement, installDomMock } from './domMock.js'

function SummaryList() {
	const wallets = useSigningWalletBindings()
	return <>{ [1n, 2n, 3n].map((address) => <SigningWalletSummary key = { address.toString() } address = { address } wallets = { wallets }/>) }</>
}

for (const failed of [false, true]) test(`wallet summary distinguishes loading from ${ failed ? 'a failed lookup' : 'an unbound address' }`, async () => {
	const dom = installDomMock()
	const previousBrowser = Object.getOwnPropertyDescriptor(globalThis, 'browser')
	const listeners: ((changes: Record<string, unknown>) => void)[] = []
	let requests = 0
	let reply: (value: unknown) => void = () => { throw new Error('Reply not initialized') }
	const pending = new Promise<unknown>((resolve) => { reply = resolve })
	Object.defineProperty(globalThis, 'browser', { configurable: true, value: { runtime: { sendMessage: async () => { requests++; return await pending } }, storage: { onChanged: { addListener: (listener: (changes: Record<string, unknown>) => void) => listeners.push(listener), removeListener: (listener: (changes: Record<string, unknown>) => void) => listeners.splice(listeners.indexOf(listener), 1) } } } })
	try {
		await act(async () => { render(h(SummaryList, {}), dom.document.body) })
		expect(requests).toBe(1)
		expect(dom.document.body.textContent).toContain('Loading signing wallet')
		expect(dom.document.body.textContent).not.toContain('No signing wallet')
		expect(findRenderedElement(dom.document.body, (node) => String(node.attributes?.['aria-busy']) === 'true')).toBeDefined()
		await act(async () => { reply(failed ? { ok: false, message: 'Wallet lookup failed' } : { ok: true, bindings: [], tabs: [] }); await pending; await new Promise((resolve) => setTimeout(resolve, 0)) })
		expect(dom.document.body.textContent).toContain(failed ? 'Wallet lookup failed' : 'No signing wallet')
		expect(dom.document.body.textContent).not.toContain('Loading signing wallet')
		if (failed) expect(dom.document.body.textContent).not.toContain('No signing wallet')
		expect(listeners).toHaveLength(1)
		await act(async () => { listeners[0]?.({ unrelated: {} }); await Promise.resolve() })
		expect(requests).toBe(1)
		await act(async () => { listeners[0]?.({ signingWalletBindings: {} }); await new Promise((resolve) => setTimeout(resolve, 0)) })
		expect(requests).toBe(2)

	} finally {
		act(() => { render(undefined, dom.document.body) })
		if (previousBrowser === undefined) Reflect.deleteProperty(globalThis, 'browser')
		else Object.defineProperty(globalThis, 'browser', previousBrowser)
		dom.restore()
	}
})
