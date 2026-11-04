import * as assert from 'assert'
import { test } from 'bun:test'
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

type RuntimeListener = (message: unknown) => unknown
const runtimeListeners = new Set<RuntimeListener>()
const backgroundFailures: unknown[] = []
let openSettingsInBackground: () => Promise<void> = async () => undefined

// One extension context: the Settings page and the background share this mock. Every storage read rejects, popup_requestSettings runs the real background handler (whose failure the background error boundary swallows, so the page gets no reply), and the background's broadcasts reach the page's listeners.
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
				async get() { throw new Error('Storage unavailable') },
				async set() { return undefined },
				async remove() { return undefined },
			},
		},
	},
})
Object.defineProperty(globalThis, 'chrome', { configurable: true, writable: true, value: { runtime: { id: 'test-extension' } } })

const { settingsOpened } = await import('../../app/ts/background/popupMessageHandlers/settings.js')
const { createSimulationServicesOwner } = await import('../../app/ts/simulation/serviceLifecycle.js')
const { SettingsView } = await import('../../app/ts/components/pages/SettingsView.js')

test('Settings opened while storage reads reject shows the RPC recovery controls instead of a blank RPC section', async () => {
	const owner = createSimulationServicesOwner(undefined, async () => undefined, async (_ethereum, error) => { throw error })
	openSettingsInBackground = async () => await settingsOpened(owner)
	const dom = installDomMock()
	try {
		await act(() => {
			render(<SettingsView />, dom.document.body)
		})
		for (let tick = 0; tick < 10; tick += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

		assert.equal(backgroundFailures.length > 0, true, 'the background request itself failed')
		const alert = collectElements(dom.document.body, 'aside').find((element) => element.getAttribute?.('role') === 'alert')
		assert.match(alert?.textContent ?? '', /could not safely read your RPC configuration/)
		assert.deepEqual(collectElements(alert, 'button').map((button) => button.textContent), ['Retry reading RPC configuration', 'Restore bundled default RPC list'])
	} finally {
		render(null, dom.document.body)
		dom.restore()
		owner.clear()
	}
})
