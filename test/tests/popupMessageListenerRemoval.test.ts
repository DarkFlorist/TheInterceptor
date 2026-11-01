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
	return { listeners, onMessage: browserMock.runtime.onMessage }
}

afterEach(() => {
	if (originalBrowserDescriptor === undefined) {
		Reflect.deleteProperty(globalThis, 'browser')
		return
	}
	Object.defineProperty(globalThis, 'browser', originalBrowserDescriptor)
})

describe('noReplyExpectingBrowserRuntimeOnMessageListener', () => {
	test('returns the registered wrapper so removing it unsubscribes the listener', () => {
		const { listeners, onMessage } = installOnMessageMock()
		const receivedMessages: unknown[] = []
		const callback = (message: unknown): false => {
			receivedMessages.push(message)
			return false
		}

		const registeredListener = noReplyExpectingBrowserRuntimeOnMessageListener(callback)

		assert.deepStrictEqual(listeners, [registeredListener])
		assert.strictEqual(registeredListener('hello'), undefined)
		assert.deepStrictEqual(receivedMessages, ['hello'])

		onMessage.removeListener(callback)
		assert.strictEqual(listeners.length, 1, 'removing the raw callback must not match the registered wrapper')

		onMessage.removeListener(registeredListener)
		assert.deepStrictEqual(listeners, [])
	})
})

describe('popup message listener cleanup architecture', () => {
	const helperCallPattern = /(?<assignment>const\s+[A-Za-z_$][\w$]*\s*=\s*)?noReplyExpectingBrowserRuntimeOnMessageListener\(\s*(?<callbackName>[A-Za-z_$][\w$]*)\s*\)/gu

	const findCleanupViolations = async () => {
		const violations: string[] = []
		const appSourceDirectory = new URL('../../app/ts/', import.meta.url).pathname
		for await (const relativePath of new Bun.Glob('**/*.{ts,tsx}').scan(appSourceDirectory)) {
			const source = await Bun.file(`${ appSourceDirectory }${ relativePath }`).text()
			for (const match of source.matchAll(helperCallPattern)) {
				const { assignment, callbackName } = match.groups ?? {}
				if (assignment === undefined) violations.push(`${ relativePath }: helper return value must be kept so it can be passed to removeListener`)
				if (callbackName !== undefined && new RegExp(`onMessage\\.removeListener\\(\\s*${ callbackName.replace(/\$/gu, '\\$') }\\s*\\)`, 'u').test(source)) {
					violations.push(`${ relativePath }: removeListener(${ callbackName }) passes the raw callback instead of the listener returned by noReplyExpectingBrowserRuntimeOnMessageListener`)
				}
			}
		}
		return violations
	}

	test('callers remove the returned wrapper instead of the raw callback', async () => {
		assert.deepStrictEqual(await findCleanupViolations(), [])
	})
})
