import { expect, test } from 'bun:test'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { SafeSigningAccounts } from '../../app/ts/components/subcomponents/SafeSigningAccounts.js'
import { SigningPageRequest } from '../../app/ts/types/directSigning.js'
import type { SafeEntry } from '../../app/ts/types/addressBookTypes.js'
import { SigningWalletBindings } from '../../app/ts/types/signingWallet.js'
import { findRenderedElement, installDomMock } from './domMock.js'

for (const changeChain of [false, true]) test(`Safe drafts reset when ${ changeChain ? 'chain' : 'address' } changes with a shared owner`, async () => {
	const dom = installDomMock()
	const previousBrowser = Object.getOwnPropertyDescriptor(globalThis, 'browser')
	const requests: SigningPageRequest[] = []
	const bindings = SigningWalletBindings.serialize([1n, 2n, 3n].map((address) => ({ wallet: { type: 'browser', address, label: `Account ${ address }`, signerName: 'MetaMask', providerId: 'io.metamask' }, revision: `00000000-0000-4000-8000-${ address.toString().padStart(12, '0') }` })))
	Object.defineProperty(globalThis, 'browser', { configurable: true, value: { runtime: { sendMessage: async (message: unknown) => {
		const request = SigningPageRequest.parse(message)
		requests.push(request)
		return request.method === 'signing_wallets' ? { ok: true, bindings } : { ok: true }
	} } } })
	const first: SafeEntry = { type: 'safe', name: 'Safe A', address: 10n, chainId: 1n, entrySource: 'User', useAsActiveAddress: true, safeSigningSignerAddress: 1n, safeExecutionAddress: 2n, safeSignerAddresses: [1n] }
	const second: SafeEntry = { ...first, name: 'Safe B', address: changeChain ? first.address : 11n, chainId: changeChain ? 2n : first.chainId, safeExecutionAddress: 3n }
	try {
		await act(async () => { render(h(SafeSigningAccounts, { safe: first }), dom.document.body) })
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
		await act(async () => { render(h(SafeSigningAccounts, { safe: second }), dom.document.body) })
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
		const executor = findRenderedElement(dom.document.body, (node) => node.tagName === 'LABEL' && node.textContent.startsWith('Execution'))
		const select = executor === undefined ? undefined : findRenderedElement(executor, (node) => node.tagName === 'SELECT')
		expect(select?.attributes.value).toBe('3')
		const save = findRenderedElement(dom.document.body, (node) => node.tagName === 'BUTTON' && node.textContent === 'Verify owner and save')
		expect(save).toBeDefined()
		await act(async () => { save?.dispatchEvent(new Event('Click')); await new Promise((resolve) => setTimeout(resolve, 0)) })
		expect(requests.find((request) => request.method === 'signing_setSafeAccounts')).toEqual({ method: 'signing_setSafeAccounts', address: second.address, chainId: second.chainId, owner: 1n, executor: 3n })
	} finally {
		act(() => { render(undefined, dom.document.body) })
		if (previousBrowser === undefined) Reflect.deleteProperty(globalThis, 'browser')
		else Object.defineProperty(globalThis, 'browser', previousBrowser)
		dom.restore()
	}
})
