import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { withSilencedConsole } from './consoleSilence.js'

type RuntimeMessage = {
	readonly method?: string
}

function installBrowserMock(sendMessage: (message: RuntimeMessage) => Promise<unknown>) {
	const storageState: Record<string, unknown> = {}
	const sentMessages: RuntimeMessage[] = []

	Object.defineProperty(globalThis, 'browser', {
		configurable: true,
		writable: true,
		value: {
			runtime: {
				lastError: undefined,
				async sendMessage(message: RuntimeMessage) {
					sentMessages.push(message)
					return await sendMessage(message)
				},
				getManifest: () => ({ manifest_version: 3 }),
				onMessage: { addListener: () => undefined, removeListener: () => undefined },
				onConnect: { addListener: () => undefined, removeListener: () => undefined },
			},
			storage: {
				local: {
					async get(keys?: string | string[] | Record<string, unknown> | null) {
						if (keys === undefined || keys === null) return { ...storageState }
						if (Array.isArray(keys)) return Object.fromEntries(keys.filter((key) => key in storageState).map((key) => [key, storageState[key]]))
						if (typeof keys === 'string') return keys in storageState ? { [keys]: storageState[keys] } : {}
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
		},
	})
	Object.defineProperty(globalThis, 'chrome', { configurable: true, writable: true, value: { runtime: { id: 'test-extension' } } })

	return { sentMessages }
}

describe('ConfirmTransaction signable message disable logic', () => {
	test('disables unsupported signable messages unless force send is enabled', async () => {
		;(globalThis as typeof globalThis & { chrome: { runtime: { id: string } } }).chrome = { runtime: { id: 'test-extension' } }
		const { shouldDisableSignableMessageConfirm } = await import('../../app/ts/components/pages/ConfirmTransaction.js')
		assert.equal(shouldDisableSignableMessageConfirm({
			isValidMessage: true,
			canSignMessage: false,
			forceSendEnabled: false,
			hasSupportedRpc: false,
		}), true)
	})

	test('allows unsupported signable messages when force send is enabled', async () => {
		;(globalThis as typeof globalThis & { chrome: { runtime: { id: string } } }).chrome = { runtime: { id: 'test-extension' } }
		const { shouldDisableSignableMessageConfirm } = await import('../../app/ts/components/pages/ConfirmTransaction.js')
		assert.equal(shouldDisableSignableMessageConfirm({
			isValidMessage: true,
			canSignMessage: false,
			forceSendEnabled: true,
			hasSupportedRpc: false,
		}), false)
	})

	test('formats confirm dialog delivery failures for centralized reporting', async () => {
		;(globalThis as typeof globalThis & { chrome: { runtime: { id: string } } }).chrome = { runtime: { id: 'test-extension' } }
		const { getConfirmDialogDeliveryErrorMessage } = await import('../../app/ts/components/pages/ConfirmTransaction.js')

		const message = getConfirmDialogDeliveryErrorMessage(new Error('background unavailable'))

		assert.equal(message, 'Failed to confirm transaction: background unavailable')
	})

	test('reports confirm dialog delivery failures with contextual popup diagnostics', async () => {
		const { sentMessages } = installBrowserMock(async (message) => {
			if (message.method === 'popup_confirmDialog') throw new Error('background unavailable')
			if (message.method === 'popup_UnexpectedErrorOccured') throw new Error('broadcast unavailable')
			return undefined
		})
		const [
			{ sendConfirmDialogMessage },
			{ getLatestUnexpectedError },
		] = await Promise.all([
			import('../../app/ts/components/pages/ConfirmTransaction.js'),
			import('../../app/ts/background/storageVariables.js'),
		])

		const localError = await withSilencedConsole(async () => await sendConfirmDialogMessage({
			method: 'popup_confirmDialog',
			data: {
				uniqueRequestIdentifier: { requestId: 1, requestSocket: { tabId: 2, connectionName: 0n } },
				action: 'accept',
			},
		}))

		const latestUnexpectedError = await getLatestUnexpectedError()
		assert.equal(sentMessages[0]?.method, 'popup_confirmDialog')
		assert.equal(sentMessages[1]?.method, 'popup_UnexpectedErrorOccured')
		assert.equal(localError?.message, 'Failed to confirm transaction: background unavailable')
		assert.equal(localError?.code, 'confirm_dialog_delivery_failed')
		assert.equal(localError?.source, 'confirmTransaction')
		assert.equal(latestUnexpectedError?.data.message, 'Failed to confirm transaction: background unavailable')
		assert.equal(latestUnexpectedError?.data.code, 'confirm_dialog_delivery_failed')
		assert.equal(latestUnexpectedError?.data.source, 'confirmTransaction')
	})
})
