import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { useResetSimulation } from '../../app/ts/components/hooks/useResetSimulation.js'
import { installDomMock } from './domMock.js'

type ResetHookApi = ReturnType<typeof useResetSimulation>

let hookApi: ResetHookApi | undefined

function installBrowserMock() {
	const previousBrowser = globalThis.browser
	const sentMessages: unknown[] = []
	Object.defineProperty(globalThis, 'browser', {
		configurable: true,
		writable: true,
		value: {
			runtime: {
				lastError: null,
				async sendMessage(message: unknown) {
					sentMessages.push(message)
					return undefined
				},
			},
		},
	})
	return {
		sentMessages,
		restore() {
			globalThis.browser = previousBrowser
		},
	}
}

function ResetHookProbe({ recoveryDelayMs }: { recoveryDelayMs: number }) {
	hookApi = useResetSimulation(recoveryDelayMs)
	return <button disabled = { hookApi.disableReset.value }>Clear</button>
}

function getHookApi() {
	if (hookApi === undefined) throw new Error('Expected reset hook to be rendered')
	return hookApi
}

async function wait(milliseconds: number) {
	await new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds))
}

describe('useResetSimulation', () => {
	test('re-enables reset when no simulation update arrives', async () => {
		const dom = installDomMock()
		const browserMock = installBrowserMock()
		hookApi = undefined
		try {
			await act(() => {
				render(h(ResetHookProbe, { recoveryDelayMs: 1 }), dom.document.body)
			})

			const resetHook = getHookApi()
			assert.equal(resetHook.disableReset.value, false)

			await act(() => {
				resetHook.resetSimulation()
			})

			assert.equal(resetHook.disableReset.value, true)
			assert.equal(browserMock.sentMessages.length, 1)

			await act(async () => {
				await wait(5)
			})

			assert.equal(resetHook.disableReset.value, false)
		} finally {
			render(null, dom.document.body)
			dom.restore()
			browserMock.restore()
			hookApi = undefined
		}
	})

	test('re-enables reset immediately when simulation data arrives', async () => {
		const dom = installDomMock()
		const browserMock = installBrowserMock()
		hookApi = undefined
		try {
			await act(() => {
				render(h(ResetHookProbe, { recoveryDelayMs: 1000 }), dom.document.body)
			})

			const resetHook = getHookApi()
			await act(() => {
				resetHook.resetSimulation()
				resetHook.markSimulationDataReceived()
			})

			assert.equal(resetHook.disableReset.value, false)
			assert.equal(browserMock.sentMessages.length, 1)
		} finally {
			render(null, dom.document.body)
			dom.restore()
			browserMock.restore()
			hookApi = undefined
		}
	})
})
