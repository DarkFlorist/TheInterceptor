import * as assert from 'assert'
import { afterEach, test } from 'bun:test'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { installDomMock } from './domMock.js'

type TestNode = {
	readonly childNodes?: readonly TestNode[]
	readonly getAttribute?: (name: string) => string | null
	readonly tagName?: string
	readonly textContent?: string
}

function collectElements(node: TestNode | undefined, tagName: string, results: TestNode[] = []) {
	if (node?.tagName === tagName.toUpperCase()) results.push(node)
	for (const child of node?.childNodes ?? []) collectElements(child, tagName, results)
	return results
}

const storedItems: Record<string, unknown> = {}
// While set, every storage read rejects with it.
let everyStorageReadError: Error | undefined
// While set, the next preference read waits for it and rejects with what it settles to.
let heldPreferenceRead: Promise<Error> | undefined

type RuntimeListener = (message: unknown) => unknown
const runtimeListeners = new Set<RuntimeListener>()
const backgroundFailures: unknown[] = []
let openSettingsInBackground: () => Promise<void> = async () => undefined

// One extension context: the Settings page and the background share this mock. popup_requestSettings runs the real background handler (whose failure the background error boundary swallows, so the page gets no reply), and the background's broadcasts reach the page's listeners.
Object.defineProperty(globalThis, 'browser', {
	configurable: true,
	writable: true,
	value: {
		runtime: {
			lastError: undefined,
			getManifest: () => ({ manifest_version: 3 }),
			getURL: (path: string) => path,
			async sendMessage(message: unknown) {
				if (typeof message === 'object' && message !== null && 'method' in message && message.method === 'popup_requestSettings') {
					try {
						await openSettingsInBackground()
					} catch (error: unknown) {
						backgroundFailures.push(error)
					}
					return undefined
				}
				for (const listener of [...runtimeListeners]) listener(message)
				return undefined
			},
			onMessage: {
				addListener: (listener: RuntimeListener) => { runtimeListeners.add(listener) },
				removeListener: (listener: RuntimeListener) => { runtimeListeners.delete(listener) },
			},
		},
		storage: {
			local: {
				async get(keys: string | readonly string[]) {
					if (everyStorageReadError !== undefined) throw everyStorageReadError
					const requestedKeys = typeof keys === 'string' ? [keys] : keys
					const preferenceRead = heldPreferenceRead
					if (preferenceRead !== undefined && requestedKeys.includes('useTabsInsteadOfPopup')) {
						heldPreferenceRead = undefined
						throw await preferenceRead
					}
					return Object.fromEntries(requestedKeys.filter((key) => key in storedItems).map((key) => [key, storedItems[key]]))
				},
				async set(items: Record<string, unknown>) { Object.assign(storedItems, items) },
				async remove() { return undefined },
			},
		},
	},
})
Object.defineProperty(globalThis, 'chrome', { configurable: true, writable: true, value: { runtime: { id: 'test-extension' } } })

const { settingsOpened } = await import('../../app/ts/background/popupMessageHandlers/settings.js')
const { createSimulationServicesOwner } = await import('../../app/ts/simulation/serviceLifecycle.js')
const { SettingsView } = await import('../../app/ts/components/pages/SettingsView.js')
const { serializeLocalStorageItems } = await import('../../app/ts/utils/storageUtils.js')

const configuredRpc = { name: 'Configured RPC', chainId: 1n, httpsRpc: 'https://configured.example', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: true }
const storeReadableRpcConfiguration = () => Object.assign(storedItems, serializeLocalStorageItems({ rpcEntries: [configuredRpc], activeRpcNetwork: configuredRpc }))

const flushAsyncWork = async () => {
	for (let tick = 0; tick < 10; tick += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

const findRpcAlert = (body: TestNode) => collectElements(body, 'aside').find((element) => element.getAttribute?.('role') === 'alert')
const getShownRpcNames = (body: TestNode) => collectElements(body, 'li').filter((item) => item.getAttribute?.('class') === 'grid brief rpc-summary').map((item) => collectElements(item, 'strong')[0]?.textContent)

const withSilencedWarnings = async <T,>(operation: () => Promise<T>) => {
	const originalWarn = console.warn
	console.warn = () => undefined
	try {
		return await operation()
	} finally {
		console.warn = originalWarn
	}
}

afterEach(() => {
	for (const key of Object.keys(storedItems)) delete storedItems[key]
	everyStorageReadError = undefined
	heldPreferenceRead = undefined
	backgroundFailures.length = 0
})

test('Settings opened while storage reads reject shows the RPC recovery controls instead of a blank RPC section', async () => {
	const owner = createSimulationServicesOwner(undefined, async () => undefined, async (_ethereum, error) => { throw error })
	openSettingsInBackground = async () => await settingsOpened(owner)
	everyStorageReadError = new Error('Storage unavailable')
	const dom = installDomMock()
	try {
		await act(() => {
			render(<SettingsView />, dom.document.body)
		})
		await flushAsyncWork()

		assert.equal(backgroundFailures.length > 0, true, 'the background request itself failed')
		const alert = findRpcAlert(dom.document.body)
		assert.match(alert?.textContent ?? '', /could not safely read your RPC configuration/)
		assert.deepEqual(collectElements(alert, 'button').map((button) => button.textContent), ['Retry reading RPC configuration', 'Restore bundled default RPC list'])
	} finally {
		render(null, dom.document.body)
		dom.restore()
		owner.clear()
	}
})

test('a slower Settings request whose preference read fails never replaces a newer available RPC list with its older outage', async () => {
	const owner = createSimulationServicesOwner(configuredRpc, async () => undefined, async (_ethereum, error) => { throw error })
	openSettingsInBackground = async () => await settingsOpened(owner)
	storeReadableRpcConfiguration()
	const dom = installDomMock()
	try {
		await act(() => {
			render(<SettingsView />, dom.document.body)
		})
		await flushAsyncWork()
		assert.deepEqual(getShownRpcNames(dom.document.body), [configuredRpc.name])

		// A starts while the RPC configuration is unreadable, and its preference read is held.
		storedItems.rpcEntries = 'not-an-rpc-list'
		let failPreferenceRead: (error: Error) => void = () => undefined
		heldPreferenceRead = new Promise<Error>((resolve) => { failPreferenceRead = resolve })
		const preferenceReadError = new Error('Preference read failed')
		const requestA = withSilencedWarnings(async () => await settingsOpened(owner))
		await flushAsyncWork()

		// B runs to completion once the configuration is readable again and publishes the available list.
		storeReadableRpcConfiguration()
		await settingsOpened(owner)
		await flushAsyncWork()
		assert.deepEqual(getShownRpcNames(dom.document.body), [configuredRpc.name])

		// A's preference read now rejects: its error still propagates, and the list stays available.
		failPreferenceRead(preferenceReadError)
		await act(async () => { await assert.rejects(requestA, (error: unknown) => error === preferenceReadError) })
		await flushAsyncWork()
		assert.equal(findRpcAlert(dom.document.body), undefined)
		assert.deepEqual(getShownRpcNames(dom.document.body), [configuredRpc.name])
	} finally {
		render(null, dom.document.body)
		dom.restore()
		owner.clear()
	}
})
