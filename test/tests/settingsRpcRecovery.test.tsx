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
// While set, the next read of `key` waits for `settled`, then rejects with the error it settles to, or reads normally when it settles to undefined.
let heldRead: { readonly key: string, readonly settled: Promise<Error | undefined> } | undefined

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
					const read = heldRead
					if (read !== undefined && requestedKeys.includes(read.key)) {
						heldRead = undefined
						const error = await read.settled
						if (error !== undefined) throw error
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
	heldRead = undefined
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

// Holds the next read of `key` until the returned function settles it (with an error to reject it).
function holdNextRead(key: string) {
	let settle: (error: Error | undefined) => void = () => undefined
	heldRead = { key, settled: new Promise<Error | undefined>((resolve) => { settle = resolve }) }
	return (error?: Error) => settle(error)
}

const renderSettingsView = async (dom: ReturnType<typeof installDomMock>) => {
	await act(() => {
		render(<SettingsView />, dom.document.body)
	})
	await flushAsyncWork()
}

test('a Settings request whose preference read fails never leaves its older outage shown over the newer available RPC list', async () => {
	const owner = createSimulationServicesOwner(configuredRpc, async () => undefined, async (_ethereum, error) => { throw error })
	openSettingsInBackground = async () => await settingsOpened(owner)
	storeReadableRpcConfiguration()
	const dom = installDomMock()
	try {
		await renderSettingsView(dom)
		assert.deepEqual(getShownRpcNames(dom.document.body), [configuredRpc.name])

		// A reads the RPC configuration while it is unreadable, and its preference read is held.
		storedItems.rpcEntries = 'not-an-rpc-list'
		const failPreferenceRead = holdNextRead('useTabsInsteadOfPopup')
		const preferenceReadError = new Error('Preference read failed')
		const requestA = withSilencedWarnings(async () => await settingsOpened(owner))
		await flushAsyncWork()
		// B starts once the configuration is readable again.
		storeReadableRpcConfiguration()
		const requestB = settingsOpened(owner)
		await flushAsyncWork()

		// A's preference read now rejects: its error still propagates, and the newer available list is what stays shown.
		failPreferenceRead(preferenceReadError)
		await act(async () => { await assert.rejects(requestA, (error: unknown) => error === preferenceReadError) })
		await act(async () => { await requestB })
		await flushAsyncWork()
		assert.equal(findRpcAlert(dom.document.body), undefined)
		assert.deepEqual(getShownRpcNames(dom.document.body), [configuredRpc.name])
	} finally {
		render(null, dom.document.body)
		dom.restore()
		owner.clear()
	}
})

test('a slower Settings request never replaces newer preferences with the ones it read earlier', async () => {
	const owner = createSimulationServicesOwner(configuredRpc, async () => undefined, async (_ethereum, error) => { throw error })
	openSettingsInBackground = async () => await settingsOpened(owner)
	storeReadableRpcConfiguration()
	storedItems.useTabsInsteadOfPopup = false
	const dom = installDomMock()
	const findTabsCheckbox = () => collectElements(dom.document.body, 'label').find((label) => label.textContent?.includes('Open popups as tabs') === true)
	try {
		await renderSettingsView(dom)

		// A reads useTabsInsteadOfPopup = false and waits on another preference read.
		const releaseMetamaskRead = holdNextRead('metamaskCompatibilityMode')
		const requestA = settingsOpened(owner)
		await flushAsyncWork()
		// B starts after the preference is changed to true.
		storedItems.useTabsInsteadOfPopup = true
		const requestB = settingsOpened(owner)
		await flushAsyncWork()

		releaseMetamaskRead()
		await act(async () => { await Promise.all([requestA, requestB]) })
		await flushAsyncWork()
		// Preact sets a checked box as the attribute, as this DOM mock has no `checked` property.
		const tabsCheckbox = collectElements(findTabsCheckbox(), 'input')[0]
		assert.notEqual(tabsCheckbox, undefined)
		assert.notEqual(tabsCheckbox?.getAttribute?.('checked') ?? null, null)
	} finally {
		render(null, dom.document.body)
		dom.restore()
		owner.clear()
	}
})
