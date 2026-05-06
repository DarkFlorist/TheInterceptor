import * as assert from 'assert'
import { describe, run, runIfRoot, should } from '../micro-should.js'

const ASYNC_RESPONSE_CLOSED_MESSAGE = 'A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received'

function installBrowserMock(errorMessage: string) {
	const storageState: Record<string, unknown> = {}
	globalThis.browser = {
		runtime: {
			lastError: null,
			async sendMessage() {
				throw new Error(errorMessage)
			},
			getManifest: () => ({ manifest_version: 3 }),
			onMessage: { addListener: () => undefined, removeListener: () => undefined },
			onConnect: { addListener: () => undefined, removeListener: () => undefined },
		},
		storage: {
			local: {
				async get(keys?: string | string[] | Record<string, unknown> | null) {
					if (keys === undefined || keys === null) return { ...storageState }
					if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, storageState[key]]))
					if (typeof keys === 'string') return { [keys]: storageState[keys] }
					return Object.fromEntries(Object.entries(keys).map(([key, defaultValue]) => [key, key in storageState ? storageState[key] : defaultValue]))
				},
				async set(items: Record<string, unknown>) {
					Object.assign(storageState, items)
				},
				async remove(keys: string | string[]) {
					for (const key of Array.isArray(keys) ? keys : [keys]) delete storageState[key]
				},
			},
		},
		tabs: {
			async query() { return [] },
			async get() { return undefined },
			async update() { return undefined },
			onUpdated: { addListener: () => undefined, removeListener: () => undefined },
			onRemoved: { addListener: () => undefined, removeListener: () => undefined },
		},
		windows: {
			async get() { return undefined },
			async update() { return undefined },
		},
		action: {
			async setIcon() { return undefined },
			async setTitle() { return undefined },
			async setBadgeText() { return undefined },
			async setBadgeBackgroundColor() { return undefined },
		},
		browserAction: {
			async setIcon() { return undefined },
			async setTitle() { return undefined },
			async setBadgeText() { return undefined },
			async setBadgeBackgroundColor() { return undefined },
		},
	} as unknown as typeof globalThis.browser
	;(globalThis as typeof globalThis & { chrome: { runtime: { id: string } } }).chrome = { runtime: { id: 'test-extension' } }
	return storageState
}

async function loadModules() {
	return {
		...await import('../../app/ts/background/backgroundUtils.js'),
		...await import('../../app/ts/background/storageVariables.js'),
	}
}

export async function main() {
	describe('backgroundUtils messaging', () => {
		should('ignore closed async response errors for popup fire-and-forget messages', async () => {
			const storageState = installBrowserMock(ASYNC_RESPONSE_CLOSED_MESSAGE)
			const { sendPopupMessageToBackgroundPage, getLatestUnexpectedError } = await loadModules()

			await sendPopupMessageToBackgroundPage({ method: 'popup_requestSettings' })

			assert.equal(storageState.latestUnexpectedError, undefined)
			assert.equal(await getLatestUnexpectedError(), undefined)
		})

		should('ignore closed async response errors when broadcasting to open popups', async () => {
			const storageState = installBrowserMock(ASYNC_RESPONSE_CLOSED_MESSAGE)
			const { sendPopupMessageToOpenWindows, getLatestUnexpectedError } = await loadModules()

			await sendPopupMessageToOpenWindows({ method: 'popup_addressBookEntriesChanged' })

			assert.equal(storageState.latestUnexpectedError, undefined)
			assert.equal(await getLatestUnexpectedError(), undefined)
		})

		should('treat null popup replies as no reply without recording an unexpected error', async () => {
			const storageState = installBrowserMock('')
			globalThis.browser.runtime.sendMessage = async () => null
			const { sendPopupMessageWithReply, getLatestUnexpectedError } = await loadModules()

			const reply = await sendPopupMessageWithReply({ method: 'popup_requestSimulationMode' })

			assert.equal(reply, undefined)
			assert.equal(storageState.latestUnexpectedError, undefined)
			assert.equal(await getLatestUnexpectedError(), undefined)
		})
	})

	await runIfRoot(run, import.meta)
}
