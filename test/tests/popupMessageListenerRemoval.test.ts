import * as assert from 'node:assert'
import { afterEach, describe, test } from 'bun:test'
import { noReplyExpectingBrowserRuntimeOnMessageListener } from '../../app/ts/utils/browser.js'

type RuntimeMessageListener = (message: unknown) => unknown

const originalBrowserDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'browser')

const installOnMessageMock = () => {
	const listeners: RuntimeMessageListener[] = []
	const browserMock = {
		runtime: {
			onMessage: {
				addListener: (listener: RuntimeMessageListener) => { listeners.push(listener) },
				removeListener: (listener: RuntimeMessageListener) => {
					const index = listeners.indexOf(listener)
					if (index !== -1) listeners.splice(index, 1)
				},
			},
			sendMessage: async () => undefined,
		},
	}
	Object.defineProperty(globalThis, 'browser', { value: browserMock, configurable: true, writable: true })
	return listeners
}

afterEach(() => {
	if (originalBrowserDescriptor === undefined) {
		Reflect.deleteProperty(globalThis, 'browser')
		return
	}
	Object.defineProperty(globalThis, 'browser', originalBrowserDescriptor)
})

describe('noReplyExpectingBrowserRuntimeOnMessageListener', () => {
	test('registers a wrapper that forwards messages and returns undefined', () => {
		const listeners = installOnMessageMock()
		const receivedMessages: unknown[] = []
		const callback = (message: unknown): false => {
			receivedMessages.push(message)
			return false
		}

		noReplyExpectingBrowserRuntimeOnMessageListener(callback)

		const [registeredListener] = listeners
		assert.strictEqual(listeners.length, 1)
		assert.notStrictEqual(registeredListener, callback)
		assert.strictEqual(registeredListener?.('hello'), undefined)
		assert.deepStrictEqual(receivedMessages, ['hello'])
	})

	test('the returned unsubscribe function removes exactly the registered wrapper', () => {
		const listeners = installOnMessageMock()
		const otherListener = () => undefined
		listeners.push(otherListener)

		const removePopupMessageListener = noReplyExpectingBrowserRuntimeOnMessageListener((): false => false)
		assert.strictEqual(listeners.length, 2)

		removePopupMessageListener()
		assert.deepStrictEqual(listeners, [otherListener])
	})
})

describe('popup message listener cleanup architecture', () => {
	test('files using the helper unsubscribe through its returned function instead of runtime.onMessage.removeListener', async () => {
		const appSourceDirectory = new URL('../../app/ts/', import.meta.url).pathname
		const violations: string[] = []
		for await (const relativePath of new Bun.Glob('**/*.{ts,tsx}').scan(appSourceDirectory)) {
			if (relativePath === 'utils/browser.ts') continue
			const source = await Bun.file(`${ appSourceDirectory }${ relativePath }`).text()
			if (source.includes('noReplyExpectingBrowserRuntimeOnMessageListener') && source.includes('runtime.onMessage.removeListener')) violations.push(relativePath)
		}
		assert.deepStrictEqual(violations, [])
	})
})
