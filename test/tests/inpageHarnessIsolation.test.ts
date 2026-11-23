import * as assert from 'node:assert'
import { test } from 'bun:test'
import { waitFor } from '../harness/async.js'
import { createFakeWindow, getPageProvider, withFakeInpageWindow } from './inpageSignerBridgeHarness.js'

test('reusing a scenario name installs a fresh provider for each fake window', async () => {
	const providerObjects: object[] = []
	for (let iteration = 0; iteration < 2; iteration++) {
		const { fakeWindow, signerRequests } = createFakeWindow()
		await withFakeInpageWindow(fakeWindow, 'repeated-scenario', async () => {
			await waitFor(() => signerRequests.includes('eth_chainId'))
			const provider = getPageProvider(fakeWindow)
			assert.equal(provider.isInterceptor, true)
			providerObjects.push(provider.object)
		})
	}
	assert.equal(providerObjects.length, 2)
	assert.notStrictEqual(providerObjects[0], providerObjects[1])
})
