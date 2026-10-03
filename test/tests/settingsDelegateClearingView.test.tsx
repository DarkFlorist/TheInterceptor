import * as assert from 'assert'
import { test } from 'bun:test'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { SettingsView } from '../../app/ts/components/pages/SettingsView.js'
import { MessageToPopup } from '../../app/ts/types/interceptor-messages.js'
import { PopupRequestsReplies } from '../../app/ts/types/interceptor-reply-messages.js'
import { serialize } from '../../app/ts/types/wire-types.js'
import { installDomMock } from './domMock.js'

type RuntimeMessageListener = (message: unknown, sender: unknown, sendResponse: (response?: unknown) => void) => boolean | undefined
type TestNode = {
	readonly tagName?: string
	readonly childNodes?: readonly TestNode[]
	readonly textContent?: string | null
	readonly dispatchEvent?: (event: Event) => boolean
}

function findDisableButton(node: TestNode): TestNode | undefined {
	if (node.tagName === 'BUTTON' && node.textContent === 'Disable') return node
	for (const child of node.childNodes ?? []) {
		const found = findDisableButton(child)
		if (found !== undefined) return found
	}
	return undefined
}

test('a delayed disable reply does not hide a newer saved delegate clearing choice', async () => {
	const dom = installDomMock()
	const previousBrowser = globalThis.browser
	const listeners: RuntimeMessageListener[] = []
	let resolveDisable: ((reply: unknown) => void) | undefined
	Object.defineProperty(globalThis, 'browser', {
		configurable: true,
		writable: true,
		value: {
			storage: { local: { async get() { return {} } } },
			runtime: {
				lastError: undefined,
				onMessage: {
					addListener(listener: RuntimeMessageListener) { listeners.push(listener) },
					removeListener(listener: RuntimeMessageListener) {
						const index = listeners.indexOf(listener)
						if (index >= 0) listeners.splice(index, 1)
					},
				},
				async sendMessage(message: { method: string }) {
					if (message.method !== 'popup_setDelegationSimulation') return undefined
					return await new Promise<unknown>((resolve) => { resolveDisable = resolve })
				},
			},
		},
	})
	const address = 0x1000000000000000000000000000000000000001n
	const chainId = 1n
	const rpc = { name: 'Test Mainnet', chainId, httpsRpc: 'https://example.test/rpc', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: true }
	const settingsReply = (generation: number, preferences: readonly { address: bigint, chainId: bigint }[]) => serialize(MessageToPopup, {
		role: 'all',
		method: 'popup_requestSettingsReply',
		popupRefreshGeneration: generation,
		data: {
			useTabsInsteadOfPopup: false,
			metamaskCompatibilityMode: false,
			safeAppsCompatibilityMode: false,
			activeRpcNetwork: rpc,
			rpcEntries: [rpc],
			delegateClearingPreferences: preferences,
		},
	})
	const dispatch = (message: unknown) => {
		for (const listener of listeners) listener(message, {}, () => undefined)
	}
	try {
		await act(() => { render(h(SettingsView, {}), dom.document.body) })
		await act(() => { dispatch(settingsReply(1, [{ address, chainId }])) })
		const button = findDisableButton(dom.document.body)
		assert.ok(button?.dispatchEvent !== undefined)
		await act(() => { button.dispatchEvent?.(new Event('Click', { bubbles: true })) })
		assert.ok(resolveDisable !== undefined)
		await act(() => { dispatch(settingsReply(3, [{ address, chainId }])) })
		resolveDisable(serialize(PopupRequestsReplies.popup_setDelegationSimulation, { method: 'popup_setDelegationSimulation', data: { ok: true, address, chainId, enabled: false } }))
		await act(async () => { await Promise.resolve() })
		assert.ok(findDisableButton(dom.document.body) !== undefined)
		await act(() => { dispatch(settingsReply(2, [])) })
		assert.ok(findDisableButton(dom.document.body) !== undefined)
	} finally {
		await act(() => { render(undefined, dom.document.body) })
		Object.defineProperty(globalThis, 'browser', { configurable: true, writable: true, value: previousBrowser })
		dom.restore()
	}
})
