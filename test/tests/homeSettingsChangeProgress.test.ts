import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { Signal } from '@preact/signals'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { Home } from '../../app/ts/components/pages/Home.js'
import type { RpcEntry } from '../../app/ts/types/rpc.js'
import { flushMicrotasks } from '../harness/async.js'
import { replaceGlobal } from '../harness/globals.js'
import { installDomMock } from './domMock.js'
import { clickElement, collectElements, getButtonByText, getPreactEventHandler, isDisabled } from './domQueries.js'
import { activeAddressEntry, getActiveAddressRow, createHomeParams, rpcNetwork } from './homePageTestHarness.js'
import { createPerTestBrowserMockInstaller } from '../harness/perTest.js'
import { getMessageWithMethod } from './runtimeMessageMatchers.js'

const installBrowserMock = createPerTestBrowserMockInstaller()

describe('Home popup settings change progress', () => {
	test('keeps mode switching busy after the saved mode arrives and exposes failures', async () => {
		const dom = installDomMock()
		const change = Promise.withResolvers<void>()
		const params = createHomeParams({ setSimulationMode: async () => { await change.promise } })
		try {
			await act(() => { render(h(Home, params), dom.document.body) })
			await act(async () => { await clickElement(getButtonByText(dom.document.body, 'Signing')) })
			assert.equal(getButtonByText(dom.document.body, 'Signing').getAttribute('aria-busy'), 'true')
			await act(() => { params.simulationMode.value = false })
			assert.equal(getButtonByText(dom.document.body, 'Signing').getAttribute('aria-busy'), 'true')
			assert.equal(String(getButtonByText(dom.document.body, 'Simulating').getAttribute('disabled')), 'true')
			await act(async () => {
				change.reject(new Error('Unable to refresh mode'))
				await flushMicrotasks()
			})
			assert.equal(dom.document.body.textContent.includes('Unable to refresh mode'), true)
			assert.equal(getButtonByText(dom.document.body, 'Simulating').getAttribute('disabled'), undefined)
		} finally {
			render(undefined, dom.document.body)
			dom.restore()
		}
	})

	for (const selection of ['other chain', 'metadata edit'] as const) test(`selects an RPC with the same URL and a different ${ selection }`, async () => {
		const dom = installDomMock()
		const nextRpc = { ...rpcNetwork, name: 'Requested network', chainId: selection === 'other chain' ? rpcNetwork.chainId + 1n : rpcNetwork.chainId }
		const requests: RpcEntry[] = []
		const params = createHomeParams({ rpcEntries: new Signal([rpcNetwork, nextRpc]), setActiveRpcAndInformAboutIt: async (entry) => { requests.push(entry) } })
		try {
			await act(() => { render(h(Home, params), dom.document.body) })
			await act(async () => { await clickElement(getButtonByText(dom.document.body, 'Requested network')) })
			assert.deepEqual(requests, [nextRpc])
		} finally {
			render(undefined, dom.document.body)
			dom.restore()
		}
	})

	test('shows wallet approval progress for RPC changes and keeps the old network on rejection', async () => {
		const dom = installDomMock()
		const nextRpc = { ...rpcNetwork, name: 'Other network', chainId: 2n, httpsRpc: 'https://other.example.test' }
		const change = Promise.withResolvers<void>()
		const params = createHomeParams({ simulationMode: new Signal(false), rpcEntries: new Signal([rpcNetwork, nextRpc]), setActiveRpcAndInformAboutIt: async () => { await change.promise } })
		try {
			await act(() => { render(h(Home, params), dom.document.body) })
			const liveStatus = collectElements(dom.document.body, 'span').find(element => element.getAttribute('class') === 'dropdown-status-text')
			assert.ok(liveStatus !== undefined)
			assert.equal(liveStatus.textContent, '')
			await act(async () => { await clickElement(getButtonByText(dom.document.body, 'Other network')) })
			const status = collectElements(dom.document.body, 'span').find(element => element.getAttribute('role') === 'status' && element.textContent === 'Waiting for wallet to switch network...')
			assert.ok(status !== undefined)
			assert.equal(status, liveStatus)
			const selector = getButtonByText(dom.document.body, rpcNetwork.name)
			assert.equal(String(selector.getAttribute('aria-busy')), 'true')
			assert.equal(status.parentNode, selector.parentNode, 'Live text must be outside the busy button')
			assert.equal(status.getAttribute('class'), 'dropdown-status-text')
			assert.ok(collectElements(selector, 'span').some(element => element.getAttribute('title') === 'Waiting for wallet to switch network...'))
			assert.equal(params.rpcNetwork.value?.httpsRpc, rpcNetwork.httpsRpc)
			await act(async () => {
				change.reject(new Error('Wallet rejected network change'))
				await flushMicrotasks()
			})
			assert.equal(dom.document.body.textContent.includes('Wallet rejected network change'), true)
			assert.equal(dom.document.body.textContent.includes('Waiting for wallet to switch network...'), false)
			assert.equal(params.rpcNetwork.value?.httpsRpc, rpcNetwork.httpsRpc)
		} finally {
			render(undefined, dom.document.body)
			dom.restore()
		}
	})

	test('shows progress for a rich toggle and reconciles persisted settings after a refresh failure', async () => {
		const dom = installDomMock()
		// The rich checkbox handler checks event.target instanceof HTMLInputElement; DOM mock inputs are mock elements.
		const restoreInputElement = replaceGlobal('HTMLInputElement', globalThis.Element)
		const browserMock = installBrowserMock()
		const change = Promise.withResolvers<void>()
		const params = createHomeParams({ setRichState: async (enabled, address) => {
			assert.equal(enabled, true)
			assert.equal(address, 'CurrentAddress')
			await change.promise
		} })
		try {
			await act(() => { render(h(Home, params), dom.document.body) })
			const checkbox = collectElements(dom.document.body, 'input').find((element) => element.getAttribute('type') === 'checkbox')
			if (checkbox === undefined) throw new Error('Expected rich checkbox')
			const handler = getPreactEventHandler(checkbox, 'Input')
			Reflect.set(checkbox, 'checked', true)
			await act(async () => { await handler({ target: checkbox }) })
			assert.equal(params.makeCurrentAddressRich.value, true)
			assert.equal(dom.document.body.textContent.includes('Updating balances...'), true)
			assert.equal(String(checkbox.getAttribute('disabled')), 'true')
			await act(async () => {
				change.reject(new Error('Balances could not be refreshed'))
				await flushMicrotasks()
			})
			assert.equal(dom.document.body.textContent.includes('Balances could not be refreshed'), true)
			assert.equal(dom.document.body.textContent.includes('Updating balances...'), false)
			assert.ok(getMessageWithMethod(browserMock.calls.runtimeSendMessage, 'popup_requestNewHomeData'))
		} finally {
			render(undefined, dom.document.body)
			restoreInputElement()
			dom.restore()
		}
	})

	test('disables wallet, mode, RPC and rich controls during another settings change', async () => {
		const dom = installDomMock()
		const params = createHomeParams({ isSettingsChangePending: new Signal(true) })
		try {
			await act(() => { render(h(Home, params), dom.document.body) })
			assert.equal(String(getButtonByText(dom.document.body, 'Signing').getAttribute('disabled')), 'true')
			assert.equal(String(getButtonByText(dom.document.body, 'Change').getAttribute('disabled')), 'true')
			for (const input of collectElements(dom.document.body, 'input').filter((element) => element.getAttribute('type') === 'checkbox')) {
				assert.equal(String(input.getAttribute('disabled')), 'true')
			}
		} finally {
			render(undefined, dom.document.body)
			dom.restore()
		}
	})

	for (const succeeds of [true, false]) {
		test(`shows the address shimmer during a switch and restores the address after ${ succeeds ? 'success' : 'failure' }`, async () => {
			const dom = installDomMock()
			const params = createHomeParams()
			const addressRow = () => getActiveAddressRow(dom.document.body)
			try {
				await act(() => { render(h(Home, params), dom.document.body) })
				assert.equal(addressRow().getAttribute('aria-busy'), undefined)
				await act(() => { params.isActiveAddressChanging.value = true })
				assert.equal(addressRow().getAttribute('aria-label'), 'Switching active address')
				assert.equal(String(addressRow().getAttribute('aria-busy')), 'true')
				assert.equal(collectElements(addressRow(), 'button').every(isDisabled), true)
				await act(() => {
					if (succeeds) {
						params.activeAddresses.value = [{ ...activeAddressEntry, address: 2n, name: 'New wallet' }]
						params.activeSimulationAddress.value = 2n
					}
					params.isActiveAddressChanging.value = false
				})
				assert.equal(addressRow().getAttribute('aria-busy'), undefined)
				assert.equal(addressRow().textContent.includes(succeeds ? 'New wallet' : activeAddressEntry.name ?? ''), true)
			} finally {
				render(undefined, dom.document.body)
				dom.restore()
			}
		})
	}

	test('shows the committed wallet while keeping further selections disabled until the request finishes', async () => {
		const dom = installDomMock()
		const pending = new Signal(true)
		try {
			await act(() => { render(h(Home, createHomeParams({ isActiveAddressChangePending: pending })), dom.document.body) })
			const addressRow = () => getActiveAddressRow(dom.document.body)
			assert.equal(addressRow().getAttribute('aria-busy'), undefined)
			assert.equal(addressRow().textContent.includes(activeAddressEntry.name ?? ''), true)
			const changeButton = () => collectElements(addressRow(), 'button').find((button) => button.textContent === 'Change')
			assert.equal(String(changeButton()?.getAttribute('disabled')), 'true')
			await act(() => { pending.value = false })
			assert.equal(changeButton()?.getAttribute('disabled'), undefined)
		} finally {
			render(undefined, dom.document.body)
			dom.restore()
		}
	})
})
