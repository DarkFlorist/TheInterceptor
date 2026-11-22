import * as assert from 'node:assert'
import { test } from 'bun:test'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { installBrowserMock } from './backgroundEthAccountsTestHarness.js'
import { installDomMock } from './domMock.js'

type TestNode = {
	readonly childNodes?: readonly TestNode[]
	readonly tagName?: string
	readonly textContent?: string
	readonly clickWithPointer?: () => void
	readonly getAttribute?: (name: string) => unknown
}
const buttonsIn = (node: TestNode): readonly TestNode[] => [
	...(node.tagName === 'BUTTON' ? [node] : []),
	...(node.childNodes ?? []).flatMap(buttonsIn),
]

test('RPC restore shows a rejected admission reply and keeps the retry action available', async () => {
	installBrowserMock()
	await browser.storage.local.set({ rpcEntries: [] })
	const busy = 'Another popup is changing settings. Please wait for it to finish, then try again.'
	let requests = 0
	browser.runtime.sendMessage = async () => { requests++; return { type: 'PopupSettingsChangeReply', ok: false, message: busy } }
	const { RpcListings } = await import('../../app/ts/components/pages/SettingsView.js')
	const dom = installDomMock()
	const createElement = dom.document.createElement.bind(dom.document)
	// This interaction needs the browser's native click property so Preact registers a lowercase click listener.
	dom.document.createElement = (tagName) => {
		const element = createElement(tagName)
		Reflect.set(element, 'onclick', undefined)
		return element
	}
	try {
		await act(() => { render(<RpcListings />, dom.document.body) })
		const button = buttonsIn(dom.document.body).find((node) => node.textContent?.includes('Yes, load'))
		if (button?.clickWithPointer === undefined) throw new Error('Expected RPC restore button')
		await act(async () => { button.clickWithPointer?.(); await new Promise((resolve) => setTimeout(resolve, 0)) })
		assert.equal(requests, 1)
		assert.ok(dom.document.body.textContent.includes(busy))
		assert.equal(button.getAttribute?.('aria-busy'), false)
		assert.equal(button.getAttribute?.('disabled'), undefined)
	} finally {
		render(null, dom.document.body)
		dom.restore()
	}
})
