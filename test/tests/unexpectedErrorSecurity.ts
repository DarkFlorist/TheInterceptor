import * as assert from 'assert'
import { describe, run, runIfRoot, should } from '../micro-should.js'

function installBrowserMock() {
	const storageState: Record<string, unknown> = {}
	const popupMessages: unknown[] = []
	globalThis.browser = {
		runtime: {
			lastError: null,
			async sendMessage(message: unknown) {
				popupMessages.push(message)
				return undefined
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
			async getAll() { return [] },
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
	return { storageState, popupMessages }
}

async function loadModules() {
	return {
		...await import('../../app/ts/background/storageVariables.js'),
		...await import('../../app/ts/background/simulationModeHanders.js'),
		...await import('../../app/ts/utils/errors.js'),
	}
}

export async function main() {
	describe('unexpected error security', () => {
		should('keep spoofed InterceptorError diagnostics out of popup state', async () => {
			const { storageState, popupMessages } = installBrowserMock()
			const { getLatestUnexpectedError, handleIterceptorError } = await loadModules()

			await handleIterceptorError({ method: 'InterceptorError', params: ['phishing text'] })

			assert.equal(storageState.latestUnexpectedError, undefined)
			assert.equal(await getLatestUnexpectedError(), undefined)
			assert.equal(popupMessages.length, 0)
		})

		should('use generic popup copy for unknown thrown values', async () => {
			const { popupMessages } = installBrowserMock()
			const { getLatestUnexpectedError, handleUnexpectedError, GENERIC_UNEXPECTED_ERROR_MESSAGE } = await loadModules()

			await handleUnexpectedError({ arbitrary: 'value' })

			const latestUnexpectedError = await getLatestUnexpectedError()
			assert.notEqual(latestUnexpectedError, undefined)
			assert.equal(latestUnexpectedError?.data.message, GENERIC_UNEXPECTED_ERROR_MESSAGE)
			assert.equal(latestUnexpectedError?.data.source, 'internal')
			assert.equal(latestUnexpectedError?.data.code, 'unexpected_error')
			assert.equal(typeof latestUnexpectedError?.data.debugId, 'string')
			assert.equal(popupMessages.length, 1)
		})

		should('preserve trusted internal Error messages for popup display', async () => {
			installBrowserMock()
			const { getLatestUnexpectedError, handleUnexpectedError } = await loadModules()

			await handleUnexpectedError(new Error('Trusted extension failure'))

			const latestUnexpectedError = await getLatestUnexpectedError()
			assert.notEqual(latestUnexpectedError, undefined)
			assert.equal(latestUnexpectedError?.data.message, 'Trusted extension failure')
			assert.equal(latestUnexpectedError?.data.source, 'internal')
			assert.equal(latestUnexpectedError?.data.code, 'unexpected_error')
			assert.equal(typeof latestUnexpectedError?.data.debugId, 'string')
		})
	})

	await runIfRoot(run, import.meta)
}
