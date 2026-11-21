import { useSigningWalletBindings } from '../../app/ts/components/hooks/useSigningWalletBindings.js'
import { expect, test } from 'bun:test'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { SigningWalletSummary } from '../../app/ts/components/subcomponents/SigningWalletSummary.js'
import { findRenderedElement, installDomMock } from './domMock.js'
import { MessageToPopup } from '../../app/ts/types/interceptor-messages.js'
import { serialize } from '../../app/ts/types/wire-types.js'

function SummaryList() {
	const wallets = useSigningWalletBindings()
	return <>{ [1n, 2n, 3n].map((address) => <SigningWalletSummary key = { address.toString() } address = { address } wallets = { wallets }/>) }</>
}

for (const failed of [false, true]) test(`wallet summary distinguishes loading from ${ failed ? 'a failed lookup' : 'an unbound address' }`, async () => {
	const dom = installDomMock()
	const previousBrowser = Object.getOwnPropertyDescriptor(globalThis, 'browser')
	const listeners: ((message: unknown) => unknown)[] = []
	let requests = 0
	let reply: (value: unknown) => void = () => { throw new Error('Reply not initialized') }
	const pending = new Promise<unknown>((resolve) => { reply = resolve })
	Object.defineProperty(globalThis, 'browser', { configurable: true, value: { runtime: { sendMessage: async () => { requests++; return await pending }, onMessage: { addListener: (listener: (message: unknown) => unknown) => listeners.push(listener), removeListener: (listener: (message: unknown) => unknown) => listeners.splice(listeners.indexOf(listener), 1) } } } })
	try {
		await act(async () => { render(h(SummaryList, {}), dom.document.body) })
		expect(requests).toBe(1)
		expect(dom.document.body.textContent).toContain('Loading signing wallet')
		expect(dom.document.body.textContent).not.toContain('No signing wallet')
		expect(findRenderedElement(dom.document.body, (node) => String(node.attributes?.['aria-busy']) === 'true')).toBeDefined()
		await act(async () => { reply(failed ? { ok: false, message: 'Wallet lookup failed' } : { ok: true, bindings: [] }); await pending; await new Promise((resolve) => setTimeout(resolve, 0)) })
		expect(dom.document.body.textContent).toContain(failed ? 'Wallet lookup failed' : 'No signing wallet')
		expect(dom.document.body.textContent).not.toContain('Loading signing wallet')
		if (failed) expect(dom.document.body.textContent).not.toContain('No signing wallet')
		expect(listeners).toHaveLength(1)
		// Only the background's binding-change announcement makes the list request the bindings again.
		await act(async () => { listeners[0]?.(serialize(MessageToPopup, { role: 'all', method: 'popup_addressBookEntriesChanged' })); await new Promise((resolve) => setTimeout(resolve, 0)) })
		expect(requests).toBe(1)
		await act(async () => { listeners[0]?.(serialize(MessageToPopup, { role: 'all', method: 'popup_signingWalletBindingsChanged' })); await new Promise((resolve) => setTimeout(resolve, 0)) })
		expect(requests).toBe(2)

	} finally {
		act(() => { render(undefined, dom.document.body) })
		if (previousBrowser === undefined) Reflect.deleteProperty(globalThis, 'browser')
		else Object.defineProperty(globalThis, 'browser', previousBrowser)
		dom.restore()
	}
})

test('"Use in simulation" selects the account entry even when a Safe shares its address', async () => {
	const { getActiveAddressSelection } = await import('../../app/ts/utils/activeAddressSelection.js')
	const { ChangeActiveAddress } = await import('../../app/ts/types/popupSettingsRequests.js')
	const dom = installDomMock()
	const previousBrowser = Object.getOwnPropertyDescriptor(globalThis, 'browser')
	const sent: unknown[] = []
	Object.defineProperty(globalThis, 'browser', { configurable: true, value: { runtime: { sendMessage: async (message: unknown) => { sent.push(message); return { type: 'ChangeActiveAddressReply', ok: true } } } } })
	const sharedAddress = 0x6000000000000000000000000000000000000006n
	try {
		await act(async () => { render(h(SigningWalletSummary, { address: sharedAddress, wallets: { bindings: [] } }), dom.document.body) })
		const button = findRenderedElement(dom.document.body, (node) => node.tagName?.toLowerCase() === 'button' && node.textContent === 'Use in simulation')
		const click = button?.l === undefined ? undefined : Object.entries(button.l).find(([key]) => key.startsWith('Click'))?.[1]
		if (click === undefined) throw new Error('Expected the Use in simulation button')
		await act(async () => { await click({ stopPropagation: () => undefined, currentTarget: button }); await new Promise((resolve) => setTimeout(resolve, 0)) })
		const request = ChangeActiveAddress.parse(sent.find((message) => typeof message === 'object' && message !== null && 'method' in message && message.method === 'popup_changeActiveAddress'))
		expect(request.data).toEqual({ activeAddress: sharedAddress, simulationMode: true, activeAddressKind: 'account' })
		// The background resolves the request to the account entry, not the Safe at the same address.
		const contact = { type: 'contact' as const, name: 'Account', address: sharedAddress, entrySource: 'User' as const, chainId: 'AllChains' as const }
		const safe = { type: 'safe' as const, name: 'Safe', address: sharedAddress, chainId: 1n, entrySource: 'User' as const, useAsActiveAddress: true }
		expect(getActiveAddressSelection(request.data.activeAddress, [safe, contact], true, 1n, [], request.data.activeAddressKind)).toEqual({ type: 'addressBookEntry', entry: contact })
	} finally {
		act(() => { render(undefined, dom.document.body) })
		if (previousBrowser === undefined) Reflect.deleteProperty(globalThis, 'browser')
		else Object.defineProperty(globalThis, 'browser', previousBrowser)
		dom.restore()
	}
})
