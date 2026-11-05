import * as assert from 'assert'
import { afterEach, describe, test } from 'bun:test'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { installDomMock } from './domMock.js'

type RuntimeListener = (message: unknown) => unknown
const noopEvent = { addListener: () => undefined, removeListener: () => undefined }
const runtimeListeners = new Set<RuntimeListener>()
const messagesToBackground: unknown[] = []

Object.defineProperty(globalThis, 'browser', {
	configurable: true,
	writable: true,
	value: {
		runtime: {
			lastError: undefined,
			getManifest: () => ({ manifest_version: 3 }),
			getURL: (path: string) => path,
			async sendMessage(message: unknown) {
				messagesToBackground.push(message)
				return undefined
			},
			onMessage: {
				addListener: (listener: RuntimeListener) => { runtimeListeners.add(listener) },
				removeListener: (listener: RuntimeListener) => { runtimeListeners.delete(listener) },
			},
		},
		storage: { local: { get: async () => ({}), set: async () => undefined, remove: async () => undefined }, onChanged: noopEvent },
		tabs: { onRemoved: noopEvent, onUpdated: noopEvent },
		windows: { onRemoved: noopEvent },
	},
})
Object.defineProperty(globalThis, 'chrome', { configurable: true, writable: true, value: { runtime: { id: 'test-extension' } } })

const { AddressBook } = await import('../../app/ts/AddressBook.js')
const { MessageToPopup } = await import('../../app/ts/types/interceptor-messages.js')
const { serialize } = await import('../../app/ts/types/wire-types.js')
type PopupRpcStatus = import('../../app/ts/types/interceptor-messages.js').PopupRpcStatus

const readableRpc = { name: 'Readable network', chainId: 5n, httpsRpc: 'https://readable.example', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: true } as const
const otherRpc = { ...readableRpc, name: 'Listed network on chain 7', chainId: 7n, httpsRpc: 'https://listed.example', primary: false }

const flushAsyncWork = async () => {
	for (let tick = 0; tick < 5; tick += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

const publishRpcStatus = async (rpcStatus: PopupRpcStatus) => {
	const message = serialize(MessageToPopup, { role: 'all', method: 'popup_requestSettingsReply', data: { useTabsInsteadOfPopup: false, metamaskCompatibilityMode: false, safeAppsCompatibilityMode: false, rpcStatus } })
	await act(async () => { for (const listener of [...runtimeListeners]) listener(message) })
	await flushAsyncWork()
}

const getAddressBookQueries = () => messagesToBackground.flatMap((message) => typeof message === 'object' && message !== null && 'method' in message && message.method === 'popup_getAddressBookData' && 'data' in message ? [message.data] : [])

const renderAddressBook = async (dom: ReturnType<typeof installDomMock>) => {
	await act(() => { render(<AddressBook />, dom.document.body) })
	await flushAsyncWork()
}

describe('AddressBook with an unavailable RPC status', () => {
	afterEach(() => {
		messagesToBackground.length = 0
		runtimeListeners.clear()
	})

	const withAddressBook = async (run: (dom: ReturnType<typeof installDomMock>) => Promise<void>) => {
		const dom = installDomMock()
		try {
			await renderAddressBook(dom)
			await run(dom)
		} finally {
			render(null, dom.document.body)
			dom.restore()
		}
	}

	test('loads the readable active network when the RPC configuration is unavailable', async () => {
		await withAddressBook(async (dom) => {
			await publishRpcStatus({ available: false, readableActiveRpcNetwork: readableRpc })

			assert.deepEqual(getAddressBookQueries().map((query) => typeof query === 'object' && query !== null && 'chainId' in query ? query.chainId : undefined), ['0x5'])
			const shownText = dom.document.body.textContent ?? ''
			assert.match(shownText, /No cute dinosaurs in My Active Addresses on Readable network/)
			assert.doesNotMatch(shownText, /undefined/)
		})
	})

	test('shows the unavailable state instead of an empty list when no network can be read', async () => {
		await withAddressBook(async (dom) => {
			await publishRpcStatus({ available: false, readableActiveRpcNetwork: undefined })

			assert.deepEqual(getAddressBookQueries(), [])
			const shownText = dom.document.body.textContent ?? ''
			assert.match(shownText, /active network could not be read/)
			assert.doesNotMatch(shownText, /No cute dinosaurs/)
			assert.doesNotMatch(shownText, /undefined/)
		})
	})

	test('keeps the listed networks and the shown chain when a later status is unavailable', async () => {
		await withAddressBook(async (dom) => {
			await publishRpcStatus({ available: true, rpcEntries: [readableRpc, otherRpc], activeRpcNetwork: readableRpc })
			await publishRpcStatus({ available: false, readableActiveRpcNetwork: undefined })

			const shownText = dom.document.body.textContent ?? ''
			assert.match(shownText, /ThaiChain/)
			assert.match(shownText, /No cute dinosaurs in My Active Addresses on Readable network/)
		})
	})
})
