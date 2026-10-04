import * as assert from 'node:assert'
import { afterEach, describe, test } from 'bun:test'
import { signal } from '@preact/signals'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { DelegationSimulationOption } from '../../app/ts/components/subcomponents/DelegationSimulationOption.js'
import type { DelegateClearingPreferences } from '../../app/ts/types/delegationSimulation.js'
import { PopupRequestsReplies } from '../../app/ts/types/interceptor-reply-messages.js'
import { findRenderedElement, installDomMock } from './domMock.js'

const address = 0x1234567890123456789012345678901234567890n
const chainId = 1n
const delegate = 0xabcdefabcdefabcdefabcdefabcdefabcdefabcdn
const activeAddress = signal({ type: 'contact' as const, name: 'Account', address, entrySource: 'User' as const, chainId })
const rpcNetwork = signal({ name: 'Ethereum', chainId, httpsRpc: 'https://rpc.example', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false })
const simulationMode = signal(true)
const preferences = signal<DelegateClearingPreferences>([])
const currentBlockNumber = signal<bigint | undefined>(undefined)

type DelegationStatus = { type: 'delegated', delegate: bigint } | { type: 'none' } | { type: 'unknown' }
let status: DelegationStatus = { type: 'delegated', delegate }
let requestedEnabled = false
let lookups = 0
let pendingSetReply: Promise<unknown> | undefined
let pendingLookupReply: Promise<unknown> | undefined

Object.defineProperty(globalThis, 'browser', {
	value: {
		runtime: {
			lastError: undefined,
			sendMessage: async (request: { method: string, data?: { enabled?: boolean } }) => {
				if (request.method === 'popup_requestDelegationSimulation') {
					lookups += 1
					if (pendingLookupReply !== undefined) return await pendingLookupReply
					return PopupRequestsReplies.popup_requestDelegationSimulation.serialize({ method: 'popup_requestDelegationSimulation', data: { address, chainId, status } })
				}
				if (request.method === 'popup_setDelegationSimulation' && request.data?.enabled !== undefined) {
					requestedEnabled = request.data.enabled
					if (pendingSetReply !== undefined) return await pendingSetReply
					preferences.value = requestedEnabled ? [{ address, chainId }] : []
					return PopupRequestsReplies.popup_setDelegationSimulation.serialize({ method: 'popup_setDelegationSimulation', data: { ok: true, address, chainId, enabled: requestedEnabled } })
				}
				throw new Error(`Unexpected request ${ request.method }`)
			},
		},
	},
	configurable: true,
	writable: true,
})

afterEach(() => {
	status = { type: 'delegated', delegate }
	requestedEnabled = false
	preferences.value = []
	lookups = 0
	pendingSetReply = undefined
	pendingLookupReply = undefined
	currentBlockNumber.value = undefined
})

function option() {
	return h(DelegationSimulationOption, { activeAddress, rpcNetwork, simulationMode, preferences, currentBlockNumber })
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
	test('rechecks a visible delegated account on new blocks and stops after no delegate is found', async () => {
		const dom = installDomMock()
		try {
			await act(() => render(option(), dom.document.body))
			await flush()
			assert.equal(lookups, 1)
			status = { type: 'none' }
			await act(() => { currentBlockNumber.value = 1n })
			await flush()
			assert.equal(lookups, 2)
			assert.equal(checkbox(dom.document.body), undefined)
			await act(() => { currentBlockNumber.value = 2n })
			await flush()
			assert.equal(lookups, 2)
		} finally {
			await act(() => render(undefined, dom.document.body))
			dom.restore()
		}
	})

	test('lets an enabled choice be disabled while its lookup never replies', async () => {
		const dom = installDomMock()
		const previousHtmlInputElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLInputElement')
		Object.defineProperty(globalThis, 'HTMLInputElement', { configurable: true, value: dom.document.createElement('input').constructor })
		try {
			preferences.value = [{ address, chainId }]
			pendingLookupReply = new Promise(() => undefined)
			await act(() => render(option(), dom.document.body))
			await flush()
			assert.equal(checkboxChecked(dom.document.body), true)
			assert.match(dom.document.body.textContent, /Could not confirm the current delegate/u)
			await changeCheckbox(dom.document.body, false)
			await flush()
			assert.equal(requestedEnabled, false)
			assert.equal(checkbox(dom.document.body), undefined)
		} finally {
			await act(() => render(undefined, dom.document.body))
			if (previousHtmlInputElement === undefined) Reflect.deleteProperty(globalThis, 'HTMLInputElement')
			else Object.defineProperty(globalThis, 'HTMLInputElement', previousHtmlInputElement)
			dom.restore()
		}
	})

	test('keeps an enabled option available after unknown and absent delegation lookups', async () => {
		const dom = installDomMock()
		const previousHtmlInputElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLInputElement')
		Object.defineProperty(globalThis, 'HTMLInputElement', { configurable: true, value: dom.document.createElement('input').constructor })
		try {
			preferences.value = [{ address, chainId }]
			status = { type: 'unknown' }
			await act(() => render(option(), dom.document.body))
			await flush()
			assert.equal(checkboxChecked(dom.document.body), true)
			assert.match(dom.document.body.textContent, /Could not confirm the current delegate/u)
			await changeCheckbox(dom.document.body, false)
			await flush()
			assert.equal(requestedEnabled, false)
			assert.equal(checkbox(dom.document.body), undefined)

			await act(() => render(undefined, dom.document.body))
			preferences.value = [{ address, chainId }]
			status = { type: 'none' }
			await act(() => render(option(), dom.document.body))
			await flush()
			assert.equal(checkboxChecked(dom.document.body), true)
			assert.match(dom.document.body.textContent, /No delegate is currently detected/u)

			await act(() => render(undefined, dom.document.body))
			preferences.value = []
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
			await act(() => { preferences.value = [{ address, chainId }]; preferences.value = [] })
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

			await act(() => { preferences.value = [{ address, chainId }] })
			assert.equal(checkboxChecked(first), true)
			assert.equal(checkboxChecked(second), true)

			await act(() => { preferences.value = [] })
			assert.equal(checkboxChecked(first), false)
			assert.equal(checkboxChecked(second), false)
			assert.equal(lookups, 2)
		} finally {
			await act(() => { render(undefined, first); render(undefined, second) })
			dom.restore()
		}
	})
})
