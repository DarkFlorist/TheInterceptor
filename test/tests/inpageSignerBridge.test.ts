import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { createFakeWindow, withFakeInpageWindow } from './inpageSignerBridgeHarness.js'
import { waitFor } from '../harness/async.js'

describe('inpage signer bridge', () => {

	test('resolves eth_requestAccounts when request-scoped provider listeners throw', async () => {
		const signerAccount = '0x1111111111111111111111111111111111111111'
		const { fakeWindow, signerRequests } = createFakeWindow({
			handleRequest: (request, sendBackgroundMessageForRequest) => {
				if (request.method !== 'eth_requestAccounts') return false
				sendBackgroundMessageForRequest({
					interceptorApproved: true,
					requestId: request.requestId,
					type: 'result',
					method: 'connect',
					result: ['0x1'],
				})
				sendBackgroundMessageForRequest({
					interceptorApproved: true,
					requestId: request.requestId,
					type: 'result',
					method: 'accountsChanged',
					result: [signerAccount],
				})
				sendBackgroundMessageForRequest({
					interceptorApproved: true,
					requestId: request.requestId,
					type: 'result',
					method: 'eth_accounts',
					result: [signerAccount],
				})
				return true
			},
		})

		await withFakeInpageWindow(fakeWindow, 'request-scoped-listener-throws', async () => {
			const provider = fakeWindow.ethereum as {
				request: (payload: { method: string, params?: readonly unknown[] }) => Promise<unknown>
				on: (eventName: string, callback: (value: unknown) => void) => void
			}
			await waitFor(() => typeof provider.request === 'function')
			await waitFor(() => signerRequests.includes('eth_chainId'))
			let connectCallbackCount = 0
			let accountCallbackCount = 0
			provider.on('connect', () => {
				connectCallbackCount += 1
				throw new Error('dapp connect listener failed')
			})
			provider.on('accountsChanged', () => {
				accountCallbackCount += 1
				throw new Error('dapp accounts listener failed')
			})

			const accountReply = await provider.request({ method: 'eth_requestAccounts' })

			assert.deepEqual(accountReply, [signerAccount])
			assert.equal(connectCallbackCount, 1)
			assert.equal(accountCallbackCount, 1)
		})
	})

})

