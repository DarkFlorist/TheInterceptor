import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { useResetSimulation } from '../../app/ts/components/hooks/useResetSimulation.js'
import { installDomMock } from './domMock.js'
import { flushMicrotasks, waitFor } from '../harness/async.js'
import { createPerTestBrowserMockInstaller } from '../harness/perTest.js'

type ResetHookApi = ReturnType<typeof useResetSimulation>

let hookApi: ResetHookApi | undefined

const installBrowserMock = createPerTestBrowserMockInstaller()

function ResetHookProbe({ recoveryDelayMs }: { recoveryDelayMs: number }) {
	hookApi = useResetSimulation(recoveryDelayMs)
	return <button disabled = { hookApi.disableReset.value }>Clear</button>
}

function getHookApi() {
	if (hookApi === undefined) throw new Error('Expected reset hook to be rendered')
	return hookApi
}

describe('useResetSimulation', () => {
	test('waits for the reset message before settling the reset action', async () => {
		const dom = installDomMock()
		const deferredReply = Promise.withResolvers<undefined>()
		const browserMock = installBrowserMock({ handlers: { runtimeMessage: async () => await deferredReply.promise } })
		hookApi = undefined
		try {
			await act(() => {
				render(h(ResetHookProbe, { recoveryDelayMs: 1000 }), dom.document.body)
			})

			const resetPromise = getHookApi().resetSimulation()
			let settled = false
			void resetPromise.then(() => { settled = true })
			await flushMicrotasks()

			assert.equal(browserMock.calls.runtimeSendMessage.length, 1)
			assert.equal(settled, false)

			deferredReply.resolve(undefined)
			await resetPromise
			assert.equal(settled, true)
		} finally {
			render(undefined, dom.document.body)
			dom.restore()
			hookApi = undefined
		}
	})

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
			assert.equal(browserMock.calls.runtimeSendMessage.length, 1)

			await act(async () => {
				await waitFor(() => !resetHook.disableReset.value, { description: 'the reset button to recover' })
			})

			assert.equal(resetHook.disableReset.value, false)
		} finally {
			render(undefined, dom.document.body)
			dom.restore()
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
			assert.equal(browserMock.calls.runtimeSendMessage.length, 1)
		} finally {
			render(undefined, dom.document.body)
			dom.restore()
			hookApi = undefined
		}
	})
})
