import * as assert from 'node:assert'
import { afterEach, describe, test } from 'bun:test'
import { signal } from '@preact/signals'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { DelegationSimulationOption } from '../../app/ts/components/subcomponents/DelegationSimulationOption.js'
import { DelegateClearingPreferences } from '../../app/ts/types/delegationSimulation.js'
import { PopupRequestsReplies } from '../../app/ts/types/interceptor-reply-messages.js'
import { serialize } from '../../app/ts/types/wire-types.js'
import { findRenderedElement, installDomMock } from './domMock.js'

const address = 0x1234567890123456789012345678901234567890n
const chainId = 1n
const delegate = 0xabcdefabcdefabcdefabcdefabcdefabcdefabcdn
const activeAddress = signal({ type: 'contact' as const, name: 'Account', address, entrySource: 'User' as const, chainId })
const rpcNetwork = signal({ name: 'Ethereum', chainId, httpsRpc: 'https://rpc.example', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false })
const simulationMode = signal(true)

type DelegationStatus = { type: 'delegated', delegate: bigint } | { type: 'none' } | { type: 'unknown' }
type StorageListener = (changes: { delegateClearingPreferences?: { newValue?: unknown } }, areaName: string) => void
const storageListeners = new Set<StorageListener>()
let status: DelegationStatus = { type: 'delegated', delegate }
let enabled = false
let lookups = 0
let pendingSetReply: Promise<unknown> | undefined

Object.defineProperty(globalThis, 'browser', {
	value: {
		runtime: {
			lastError: undefined,
			sendMessage: async (request: { method: string, data?: { enabled?: boolean } }) => {
				if (request.method === 'popup_requestDelegationSimulation') {
					lookups += 1
					return PopupRequestsReplies.popup_requestDelegationSimulation.serialize({ method: 'popup_requestDelegationSimulation', data: { address, chainId, status, enabled } })
				}
				if (request.method === 'popup_setDelegationSimulation' && request.data?.enabled !== undefined) {
					enabled = request.data.enabled
					if (pendingSetReply !== undefined) return await pendingSetReply
					return PopupRequestsReplies.popup_setDelegationSimulation.serialize({ method: 'popup_setDelegationSimulation', data: { ok: true, address, chainId, enabled } })
				}
				throw new Error(`Unexpected request ${ request.method }`)
			},
		},
		storage: {
			onChanged: {
			addListener: (listener: StorageListener) => storageListeners.add(listener),
			removeListener: (listener: StorageListener) => storageListeners.delete(listener),
		},
		},
	},
	configurable: true,
	writable: true,
})

afterEach(() => {
	status = { type: 'delegated', delegate }
	enabled = false
	lookups = 0
	pendingSetReply = undefined
	storageListeners.clear()
})

function option() {
	return h(DelegationSimulationOption, { activeAddress, rpcNetwork, simulationMode })
}

function checkbox(root: Parameters<typeof findRenderedElement>[0]) {
	return findRenderedElement(root, (node) => node.tagName === 'INPUT')
}

function checkboxChecked(root: Parameters<typeof findRenderedElement>[0]) {
	const input = checkbox(root)
	if (input === undefined) return undefined
	return Reflect.get(Reflect.get(input, 'attributes') ?? {}, 'checked') === true
}

async function changeCheckbox(root: Parameters<typeof findRenderedElement>[0], checked: boolean) {
	const input = checkbox(root)
	if (input === undefined) throw new Error('Expected a delegate clearing checkbox')
	const onInput = Object.entries(input.l ?? {}).find(([name]) => name.toLowerCase().startsWith('input'))?.[1]
	if (onInput === undefined) throw new Error(`Expected a delegate clearing input handler; found ${ Object.keys(input.l ?? {}).join(', ') }`)
	Reflect.set(input, 'checked', checked)
	await act(async () => { onInput({ target: input }); await Promise.resolve() })
}

async function flush() {
	await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

describe('delegation simulation option', () => {
	test('keeps an enabled option available after unknown and absent delegation lookups', async () => {
		const dom = installDomMock()
		const previousHtmlInputElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLInputElement')
		Object.defineProperty(globalThis, 'HTMLInputElement', { configurable: true, value: dom.document.createElement('input').constructor })
		try {
			enabled = true
			status = { type: 'unknown' }
			await act(() => render(option(), dom.document.body))
			await flush()
			assert.equal(checkboxChecked(dom.document.body), true)
			assert.match(dom.document.body.textContent, /Could not confirm the current delegate/u)
			await changeCheckbox(dom.document.body, false)
			await flush()
			assert.equal(enabled, false)
			assert.equal(checkbox(dom.document.body), undefined)

			await act(() => render(undefined, dom.document.body))
			enabled = true
			status = { type: 'none' }
			await act(() => render(option(), dom.document.body))
			await flush()
			assert.equal(checkboxChecked(dom.document.body), true)
			assert.match(dom.document.body.textContent, /No delegate is currently detected/u)

			await act(() => render(undefined, dom.document.body))
			enabled = false
			await act(() => render(option(), dom.document.body))
			await flush()
			assert.equal(checkbox(dom.document.body), undefined)
		} finally {
			await act(() => render(undefined, dom.document.body))
			if (previousHtmlInputElement === undefined) Reflect.deleteProperty(globalThis, 'HTMLInputElement')
			else Object.defineProperty(globalThis, 'HTMLInputElement', previousHtmlInputElement)
			dom.restore()
		}
	})

	test('does not let a delayed toggle reply undo a newer settings import', async () => {
		const dom = installDomMock()
		const previousHtmlInputElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLInputElement')
		Object.defineProperty(globalThis, 'HTMLInputElement', { configurable: true, value: dom.document.createElement('input').constructor })
		const first = dom.document.createElement('div')
		const second = dom.document.createElement('div')
		dom.document.body.appendChild(first)
		dom.document.body.appendChild(second)
		let resolveSetReply: (reply: unknown) => void = () => undefined
		pendingSetReply = new Promise((resolve) => { resolveSetReply = resolve })
		try {
			await act(() => { render(option(), first); render(option(), second) })
			await flush()
			assert.equal(checkboxChecked(first), false)
			assert.equal(checkboxChecked(second), false)
			await changeCheckbox(first, true)
			await act(() => {
				const newValue = serialize(DelegateClearingPreferences, [{ address, chainId }])
				for (const listener of storageListeners) listener({ delegateClearingPreferences: { newValue } }, 'local')
				for (const listener of storageListeners) listener({ delegateClearingPreferences: { newValue: [] } }, 'local')
			})
			assert.equal(checkboxChecked(first), false)
			assert.equal(checkboxChecked(second), false)
			resolveSetReply(PopupRequestsReplies.popup_setDelegationSimulation.serialize({ method: 'popup_setDelegationSimulation', data: { ok: true, address, chainId, enabled: true } }))
			await flush()
			assert.equal(checkboxChecked(first), false)
			assert.equal(checkboxChecked(second), false)
			assert.equal(lookups, 2)
		} finally {
			await act(() => { render(undefined, first); render(undefined, second) })
			if (previousHtmlInputElement === undefined) Reflect.deleteProperty(globalThis, 'HTMLInputElement')
			else Object.defineProperty(globalThis, 'HTMLInputElement', previousHtmlInputElement)
			dom.restore()
		}
	})

	test('updates two open views after a toggle or settings import without another RPC lookup', async () => {
		const dom = installDomMock()
		const first = dom.document.createElement('div')
		const second = dom.document.createElement('div')
		dom.document.body.appendChild(first)
		dom.document.body.appendChild(second)
		try {
			await act(() => { render(option(), first); render(option(), second) })
			await flush()
			assert.equal(lookups, 2)
			assert.equal(checkboxChecked(first), false)
			assert.equal(checkboxChecked(second), false)

			await act(() => {
				const newValue = serialize(DelegateClearingPreferences, [{ address, chainId }])
				for (const listener of storageListeners) listener({ delegateClearingPreferences: { newValue } }, 'local')
			})
			assert.equal(checkboxChecked(first), true)
			assert.equal(checkboxChecked(second), true)

			await act(() => {
				for (const listener of storageListeners) listener({ delegateClearingPreferences: { newValue: [] } }, 'local')
			})
			assert.equal(checkboxChecked(first), false)
			assert.equal(checkboxChecked(second), false)
			assert.equal(lookups, 2)
		} finally {
			await act(() => { render(undefined, first); render(undefined, second) })
			dom.restore()
		}
	})
})
