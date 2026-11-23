import * as assert from 'node:assert'
import { test } from 'bun:test'
import { waitFor } from '../harness/async.js'
import { createFakeWindow, getPageProvider, withFakeInpageWindow } from './inpageSignerBridgeHarness.js'

test('reusing a scenario name installs a fresh provider for each fake window', async () => {
	const providers: ReturnType<typeof getPageProvider>[] = []
	for (let iteration = 0; iteration < 2; iteration++) {
		const { fakeWindow, signerRequests } = createFakeWindow()
		await withFakeInpageWindow(fakeWindow, 'repeated-scenario', async () => {
			await waitFor(() => signerRequests.includes('eth_chainId'))
			providers.push(getPageProvider(fakeWindow))
		})
	}
	assert.equal(providers.length, 2)
	assert.notStrictEqual(providers[0], providers[1])
})
