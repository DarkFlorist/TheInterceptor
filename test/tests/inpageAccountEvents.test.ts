import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { waitFor } from '../harness/async.js'
import { replaceProperty } from '../harness/globals.js'
import { captureTimerCallbackErrors, createFakeWindow, getPageProvider, type InpageRequest, waitOneEventLoopTurn, withFakeInpageWindow } from './inpageSignerBridgeHarness.js'
import { readProperty } from '../harness/assertions.js'

describe('inpage account exposure and request-scoped provider events', () => {
	test('avoid hidden signer account sync on connect and preserve explicit account replies', async () => {
		const {
			fakeWindow,
			signerRequests,
			backgroundEthAccountsReplies,
			signerAccounts,
			interceptorErrorPayloads,
			sendBackgroundMessage,
			setBlockRequestAccounts,
			rejectPendingRequestAccounts,
		} = createFakeWindow()
		const originalDispatchEvent = fakeWindow.dispatchEvent

		await withFakeInpageWindow(fakeWindow, 'hidden-signer-account-sync', async () => {
			await waitFor(() => signerRequests.length >= 1)
			assert.deepEqual(signerRequests, ['eth_chainId'])
			assert.strictEqual(fakeWindow.dispatchEvent, originalDispatchEvent)
			const provider = getPageProvider(fakeWindow)
			try {
				await provider.request({ method: 'eth_accounts_reply', params: [] })
				assert.fail('public internal provider method should reject')
			} catch (error: unknown) {
				if (!(typeof error === 'object' && error !== null && 'code' in error)) throw error
				assert.equal(error.code, -32004)
			}
			assert.deepEqual(provider.send({ id: 77, method: 'eth_coinbase', params: [] }), { jsonrpc: '2.0', id: 77, result: null })
			let batchCallbackCount = 0
			const batchReply = await new Promise<unknown>((resolve, reject) => {
				void provider.sendAsync([
					{ id: 91, method: 'eth_chainId', params: [] },
					{ id: 92, method: 'eth_accounts', params: [] },
				], (error, response) => {
					batchCallbackCount++
					if (error !== null) {
						reject(error)
						return
					}
					resolve(response)
				})
			})
			assert.equal(batchCallbackCount, 1)
			assert.deepEqual(batchReply, [
				{ jsonrpc: '2.0', id: 91, result: '0x' },
				{ jsonrpc: '2.0', id: 92, result: '0x' },
			])
			const connectEvents: unknown[] = []
			provider.on('connect', (value) => connectEvents.push(value))
			sendBackgroundMessage({
				interceptorApproved: true,
				type: 'result',
				method: 'disconnect',
				result: [],
			})
			sendBackgroundMessage({
				interceptorApproved: true,
				type: 'result',
				method: 'connect',
				result: ['0x1'],
			})
			await waitFor(() => connectEvents.length === 1)
			assert.deepEqual(connectEvents, [{ chainId: '0x1' }])

			sendBackgroundMessage({
				interceptorApproved: true,
				type: 'result',
				method: 'request_signer_to_eth_accounts',
				result: [],
			})
			await waitFor(() => signerRequests.includes('eth_accounts'))
			assert.deepEqual(signerRequests, ['eth_chainId', 'eth_accounts'])
			await waitFor(() => backgroundEthAccountsReplies.length === 1)
			assert.deepEqual(backgroundEthAccountsReplies[0]?.accounts, signerAccounts)

			sendBackgroundMessage({
				interceptorApproved: true,
				type: 'result',
				method: 'request_signer_to_eth_requestAccounts',
				result: [],
			})
			await waitFor(() => signerRequests.filter((method) => method === 'eth_requestAccounts').length === 1)
			assert.deepEqual(signerRequests, ['eth_chainId', 'eth_accounts', 'eth_requestAccounts'])
			await waitFor(() => backgroundEthAccountsReplies.length === 2)
			assert.deepEqual(backgroundEthAccountsReplies[1]?.accounts, signerAccounts)
			setBlockRequestAccounts(true)
			sendBackgroundMessage({
				interceptorApproved: true,
				type: 'result',
				method: 'request_signer_to_eth_requestAccounts',
				result: [],
			})
			sendBackgroundMessage({
				interceptorApproved: true,
				type: 'result',
				method: 'request_signer_to_eth_requestAccounts',
				result: [],
			})
			await waitFor(() => signerRequests.filter((method) => method === 'eth_requestAccounts').length === 2)
			rejectPendingRequestAccounts({ code: 4001, message: 'User rejected the request.' })
			await waitFor(() => backgroundEthAccountsReplies.length === 4)
			assert.deepEqual(backgroundEthAccountsReplies.slice(2), [
				{ type: 'error', requestAccounts: true, signerProviderGeneration: 2, error: { code: 4001, message: 'User rejected the request.' } },
				{ type: 'error', requestAccounts: true, signerProviderGeneration: 2, error: { code: 4001, message: 'User rejected the request.' } },
			])

			const signerRequestCountBeforeSpoof = signerRequests.length
			fakeWindow.dispatchEvent({
				type: 'message',
				data: {
					interceptorApproved: true,
					requestId: 999,
					type: 'forwardToSigner',
					method: 'eth_accounts',
					params: [],
				},
			})
			fakeWindow.dispatchEvent({
				type: 'message',
				data: {
					interceptorApproved: true,
					type: 'result',
					method: 'request_signer_to_eth_requestAccounts',
					result: [],
				},
			})
			await waitOneEventLoopTurn()
			assert.equal(signerRequests.length, signerRequestCountBeforeSpoof)
			assert.equal(interceptorErrorPayloads.length, 0)

			const lateSignerRequests: string[] = []
			const lateSigner = {
				isMetaMask: true,
				isConnected: () => true,
				request: async ({ method }: { method: string }) => {
					lateSignerRequests.push(method)
					if (method === 'eth_chainId') return '0x1'
					if (method === 'eth_accounts') return signerAccounts
					throw new Error(`Unexpected late signer request: ${ method }`)
				},
				on: () => lateSigner,
				removeListener: () => lateSigner,
			}
			fakeWindow.ethereum = lateSigner
			fakeWindow.dispatchEvent({ type: 'ethereum#initialized' })
			await waitFor(() => lateSignerRequests.length >= 1)
			assert.equal(lateSignerRequests[0], 'eth_chainId')
			assert.equal(readProperty(fakeWindow.ethereum, 'isInterceptor'), true)
			assert.strictEqual(fakeWindow.dispatchEvent, originalDispatchEvent)
		})
	})

	test('keeps standalone eth_accounts replies free of console warnings', async () => {
		const signerAccount = '0x1111111111111111111111111111111111111111'
		const warnings: unknown[][] = []
		const restoreWarn = replaceProperty(console, 'warn', (...args: unknown[]) => { warnings.push(args) })
		const { fakeWindow } = createFakeWindow({
			handleRequest: (request, sendBackgroundMessageForRequest) => {
				if (request.method !== 'eth_accounts') return false
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

		try {
			await withFakeInpageWindow(fakeWindow, 'standalone-eth-accounts-no-warnings', async () => {
				const provider = getPageProvider(fakeWindow)
				assert.deepEqual(await provider.request({ method: 'eth_accounts' }), [signerAccount])
			})
			assert.equal(warnings.length, 0)
		} finally {
			restoreWarn()
		}
	})

	test('does not forward signer accountsChanged as an unscoped update during eth_requestAccounts', async () => {
		const signerAccount = '0x1111111111111111111111111111111111111111'
		const {
			fakeWindow,
			signerRequests,
			backgroundEthAccountsReplies,
			sendBackgroundMessage,
			setBlockRequestAccounts,
			resolvePendingRequestAccounts,
			emitSignerEvent,
		} = createFakeWindow()

		await withFakeInpageWindow(fakeWindow, 'request-accounts-suppresses-signer-event', async () => {
			await waitFor(() => signerRequests.includes('eth_chainId'))
			setBlockRequestAccounts(true)
			sendBackgroundMessage({
				interceptorApproved: true,
				type: 'result',
				method: 'request_signer_to_eth_requestAccounts',
				result: [],
			})
			await waitFor(() => signerRequests.includes('eth_requestAccounts'))
			emitSignerEvent('accountsChanged', [signerAccount])
			await waitOneEventLoopTurn()
			assert.deepEqual(backgroundEthAccountsReplies, [])

			resolvePendingRequestAccounts([signerAccount])
			await waitFor(() => backgroundEthAccountsReplies.length === 1)
			assert.deepEqual(backgroundEthAccountsReplies, [
				{ type: 'success', accounts: [signerAccount], requestAccounts: true, signerProviderGeneration: 2 },
			])
		})
	})

	test('delivers request-scoped accountsChanged without connect before eth_requestAccounts resumes even when address is cached', async () => {
		const signerAccount = '0x1111111111111111111111111111111111111111'
		const { fakeWindow, sendBackgroundMessage, signerRequests } = createFakeWindow({
			handleRequest: (request, sendBackgroundMessageForRequest) => {
				if (request.method !== 'eth_requestAccounts') return false
				sendBackgroundMessageForRequest({
					interceptorApproved: true,
					requestId: request.requestId,
					type: 'result',
					method: 'accountsChanged',
					result: [signerAccount],
				})
				setTimeout(() => {
					setTimeout(() => {
						setTimeout(() => {
							sendBackgroundMessageForRequest({
								interceptorApproved: true,
								requestId: request.requestId,
								type: 'result',
								method: 'eth_accounts',
								result: [signerAccount],
							})
						}, 0)
					}, 0)
				}, 0)
				return true
			},
		})

		await withFakeInpageWindow(fakeWindow, 'request-scoped-accounts-changed', async () => {
			const provider = getPageProvider(fakeWindow)
			await waitFor(() => signerRequests.includes('eth_chainId'))
			sendBackgroundMessage({
				interceptorApproved: true,
				type: 'result',
				method: 'accountsChanged',
				result: [signerAccount],
			})
			await waitFor(() => readProperty(fakeWindow.ethereum, 'selectedAddress') === signerAccount)
			const events: string[] = []
			const accountEvents: (readonly string[])[] = []
			provider.on('accountsChanged', (accounts) => {
				events.push('accountsChanged')
				if (!Array.isArray(accounts) || !accounts.every((account): account is string => typeof account === 'string')) throw new Error('accountsChanged payload was not a string array')
				accountEvents.push(accounts)
			})
			provider.on('connect', (connectInfo) => {
				events.push('connect')
				assert.deepEqual(connectInfo, { chainId: '0x1' })
			})

			const accountReply = await provider.request({ method: 'eth_requestAccounts' }).then((accounts) => {
				events.push('resolved')
				return accounts
			})
			await waitFor(() => accountEvents.length === 1)

			assert.deepEqual(accountReply, [signerAccount])
			assert.deepEqual(accountEvents, [[signerAccount]])
			assert.deepEqual(events, ['accountsChanged', 'resolved'])
		})
	})

	test('delivers request-scoped accountsChanged without connect before wallet_requestPermissions resumes', async () => {
		const signerAccount = '0x1212121212121212121212121212121212121212'
		const permissions = [{
			parentCapability: 'eth_accounts',
			caveats: [{
				type: 'restrictReturnedAccounts',
				value: [signerAccount],
			}],
			invoker: 'https://example.test',
		}]
		const { fakeWindow, signerRequests } = createFakeWindow({
			handleRequest: (request, sendBackgroundMessageForRequest) => {
				if (request.method !== 'wallet_requestPermissions') return false
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
					method: 'wallet_requestPermissions',
					result: permissions,
				})
				return true
			},
		})

		await withFakeInpageWindow(fakeWindow, 'request-scoped-wallet-permissions', async () => {
			const provider = getPageProvider(fakeWindow)
			await waitFor(() => signerRequests.includes('eth_chainId'))
			const events: string[] = []
			provider.on('connect', (connectInfo) => {
				events.push('connect')
				assert.deepEqual(connectInfo, { chainId: '0x1' })
			})
			provider.on('accountsChanged', (accounts) => {
				events.push('accountsChanged')
				assert.deepEqual(accounts, [signerAccount])
			})

			const permissionReply = await provider.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] }).then((reply) => {
				events.push('resolved')
				return reply
			})

			assert.deepEqual(permissionReply, permissions)
			assert.deepEqual(events, ['accountsChanged', 'resolved'])
		})
	})

	test('resolves eth_requestAccounts when request-scoped provider listeners throw', async () => {
		const signerAccount = '0x1111111111111111111111111111111111111111'
		const { fakeWindow, signerRequests, interceptorErrorPayloads } = createFakeWindow({
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

		const timerErrors = captureTimerCallbackErrors()
		try {
			await withFakeInpageWindow(fakeWindow, 'request-scoped-listener-throws', async () => {
				const provider = getPageProvider(fakeWindow)
				await waitFor(() => signerRequests.includes('eth_chainId'))
				let connectCallbackCount = 0
				let accountCallbackCount = 0
				const connectListenerError = new Error('dapp connect listener failed')
				const accountsListenerError = new Error('dapp accounts listener failed')
				provider.on('connect', () => {
					connectCallbackCount += 1
					throw connectListenerError
				})
				provider.on('accountsChanged', () => {
					accountCallbackCount += 1
					throw accountsListenerError
				})

				const accountReply = await provider.request({ method: 'eth_requestAccounts' })

				assert.deepEqual(accountReply, [signerAccount])
				assert.equal(connectCallbackCount, 1)
				assert.equal(accountCallbackCount, 1)
				await waitFor(() => timerErrors.errors.length === 2)
				assert.deepEqual(timerErrors.errors, [connectListenerError, accountsListenerError])
				assert.deepEqual(interceptorErrorPayloads, [])
			})
		} finally {
			timerErrors.restore()
		}
	})

	test('keeps notifying later accountsChanged listeners after a dapp listener throws, without reporting an Interceptor error', async () => {
		const signerAccount = '0x1111111111111111111111111111111111111111'
		const { fakeWindow, signerRequests, sendBackgroundMessage, interceptorErrorPayloads } = createFakeWindow()
		const timerErrors = captureTimerCallbackErrors()
		try {
			await withFakeInpageWindow(fakeWindow, 'throwing-accounts-changed-listener', async () => {
				const provider = getPageProvider(fakeWindow)
				await waitFor(() => signerRequests.includes('eth_chainId'))
				const listenerError = new Error('dapp accounts listener failed')
				const accountsSeenByLaterListener: unknown[] = []
				provider.on('accountsChanged', () => { throw listenerError })
				provider.on('accountsChanged', (accounts) => { accountsSeenByLaterListener.push(accounts) })

				sendBackgroundMessage({ interceptorApproved: true, type: 'result', method: 'accountsChanged', result: [signerAccount] })

				// The dapp's error reaches the page as an uncaught error from a timer instead of interrupting the Interceptor's message handling.
				await waitFor(() => timerErrors.errors.length === 1)
				assert.deepEqual(accountsSeenByLaterListener, [[signerAccount]])
				assert.deepEqual(timerErrors.errors, [listenerError])
				await waitOneEventLoopTurn()
				assert.deepEqual(interceptorErrorPayloads, [])
			})
		} finally {
			timerErrors.restore()
		}
	})

	test('drops stale request-scoped provider events after eth_requestAccounts settles', async () => {
		const signerAccount = '0x1111111111111111111111111111111111111111'
		const staleAccount = '0x2222222222222222222222222222222222222222'
		let accountRequest: InpageRequest | undefined
		let sendForAccountRequest: ((data: unknown) => void) | undefined
		const { fakeWindow, signerRequests } = createFakeWindow({
			handleRequest: (request, sendBackgroundMessageForRequest) => {
				if (request.method !== 'eth_requestAccounts') return false
				accountRequest = request
				sendForAccountRequest = sendBackgroundMessageForRequest
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

		await withFakeInpageWindow(fakeWindow, 'stale-request-scoped-events', async () => {
			const provider = getPageProvider(fakeWindow)
			await waitFor(() => signerRequests.includes('eth_chainId'))
			const events: string[] = []
			provider.on('connect', () => {
				events.push('connect')
			})
			provider.on('accountsChanged', () => {
				events.push('accountsChanged')
			})
			provider.on('disconnect', () => {
				events.push('disconnect')
			})
			provider.on('chainChanged', () => {
				events.push('chainChanged')
			})

			assert.deepEqual(await provider.request({ method: 'eth_requestAccounts' }), [signerAccount])
			const connectedAfterRequest = provider.isConnected()
			const chainIdAfterRequest = provider.chainId
			assert.equal(provider.selectedAddress, undefined)
			assert.deepEqual(readProperty(fakeWindow.web3, 'accounts'), [])
			if (accountRequest === undefined || sendForAccountRequest === undefined) throw new Error('eth_requestAccounts was not captured')
			sendForAccountRequest({
				interceptorApproved: true,
				requestId: accountRequest.requestId,
				type: 'result',
				method: 'connect',
				result: ['0x1'],
			})
			sendForAccountRequest({
				interceptorApproved: true,
				requestId: accountRequest.requestId,
				type: 'result',
				method: 'accountsChanged',
				result: [staleAccount],
			})
			sendForAccountRequest({
				interceptorApproved: true,
				requestId: accountRequest.requestId,
				type: 'result',
				method: 'disconnect',
				result: [],
			})
			sendForAccountRequest({
				interceptorApproved: true,
				requestId: accountRequest.requestId,
				type: 'result',
				method: 'chainChanged',
				result: '0x2',
			})
			await waitOneEventLoopTurn()
			await waitOneEventLoopTurn()

			assert.deepEqual(events, [])
			assert.equal(provider.isConnected(), connectedAfterRequest)
			assert.equal(provider.chainId, chainIdAfterRequest)
			assert.equal(provider.selectedAddress, undefined)
			assert.deepEqual(readProperty(fakeWindow.web3, 'accounts'), [])
		})
	})
})
