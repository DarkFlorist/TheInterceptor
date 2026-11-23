import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { waitFor } from '../harness/async.js'
import { createFakeWindow, getPageProvider, type InpageRequest, isForwardRequestCandidate, isJsonRpcResponseCandidate, isRpcErrorCandidate, isSignerReplyCandidate, type SignerRequest, waitOneEventLoopTurn, withFakeInpageWindow } from './inpageSignerBridgeHarness.js'

describe('inpage request forwarding, replies and error propagation', () => {
	test('returns JSON-RPC failures through the sendAsync response argument', async () => {
		const { fakeWindow } = createFakeWindow({
			handleRequest: (request, sendBackgroundMessage) => {
				if (request.method !== 'eth_chainId' || request.internal === true) return false
				sendBackgroundMessage({
					interceptorApproved: true,
					requestId: request.requestId,
					type: 'result',
					method: request.method,
					error: { code: -32000, message: 'RPC failed' },
				})
				return true
			},
		})

		await withFakeInpageWindow(fakeWindow, 'send-async-json-rpc-error', async () => {
			const { sendAsync } = getPageProvider(fakeWindow)
			const callbackArguments = await new Promise<readonly [unknown, unknown]>((resolve) => {
				void sendAsync({ id: 71, method: 'eth_chainId', params: [] }, (error: unknown, response: unknown) => resolve([error, response]))
			})

			assert.equal(callbackArguments[0], null)
			const response = callbackArguments[1]
			if (!isJsonRpcResponseCandidate(response) || !isRpcErrorCandidate(response.error)) throw new Error('Malformed JSON-RPC error response')
			assert.equal(response.id, 71)
			assert.equal(response.error.code, -32000)
			assert.equal(response.error.message, 'RPC failed')
		})
	})

	test('returns bridge transport failures through the sendAsync error argument', async () => {
		const { fakeWindow, signerRequests } = createFakeWindow()

		await withFakeInpageWindow(fakeWindow, 'send-async-transport-error', async () => {
			await waitFor(() => signerRequests.includes('eth_chainId'))
			await waitOneEventLoopTurn()
			const { sendAsync } = getPageProvider(fakeWindow)
			const postMessageDescriptor = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'postMessage')
			if (postMessageDescriptor === undefined) throw new Error('MessagePort.postMessage descriptor is unavailable')
			Object.defineProperty(MessagePort.prototype, 'postMessage', {
				...postMessageDescriptor,
				value: () => { throw new Error('bridge transport failed') },
			})
			let callbackArguments: readonly [unknown, unknown]
			try {
				callbackArguments = await new Promise<readonly [unknown, unknown]>((resolve) => {
					void sendAsync({ id: 72, method: 'eth_chainId', params: [] }, (error: unknown, response: unknown) => resolve([error, response]))
				})
			} finally {
				Object.defineProperty(MessagePort.prototype, 'postMessage', postMessageDescriptor)
			}

			assert.equal(callbackArguments[0] instanceof Error, true)
			if (!(callbackArguments[0] instanceof Error)) throw new Error('Expected a transport Error')
			assert.equal(callbackArguments[0].message, 'bridge transport failed')
			assert.equal(callbackArguments[1], null)
		})
	})

	test('does not invoke a sendAsync callback twice when the dapp callback throws', async () => {
		const { fakeWindow } = createFakeWindow({
			handleRequest: (request, sendBackgroundMessage) => {
				if (request.method !== 'eth_chainId' || request.internal === true) return false
				sendBackgroundMessage({
					interceptorApproved: true,
					requestId: request.requestId,
					type: 'result',
					method: request.method,
					error: { code: -32000, message: 'RPC failed' },
				})
				return true
			},
		})

		await withFakeInpageWindow(fakeWindow, 'send-async-callback-error', async () => {
			const { sendAsync } = getPageProvider(fakeWindow)
			let callbackCount = 0
			await assert.rejects(async () => await sendAsync({ id: 73, method: 'eth_chainId', params: [] }, () => {
				callbackCount += 1
				throw new Error('dapp callback failed')
			}), /dapp callback failed/)
			assert.equal(callbackCount, 1)
		})
	})

	test('annotates only public eth_requestAccounts requests for replay after disconnect', async () => {
		const bridgeRequests: InpageRequest[] = []
		const account = '0x1111111111111111111111111111111111111111'
		const transactionHash = '0x1111111111111111111111111111111111111111111111111111111111111111'
		const { fakeWindow } = createFakeWindow({
			handleRequest: (request, sendBackgroundMessageForRequest) => {
				bridgeRequests.push(request)
				if (request.method === 'eth_requestAccounts') {
					sendBackgroundMessageForRequest({
						interceptorApproved: true,
						requestId: request.requestId,
						type: 'result',
						method: 'eth_accounts',
						result: [account],
					})
					return true
				}
				if (request.method === 'eth_sendTransaction') {
					sendBackgroundMessageForRequest({
						interceptorApproved: true,
						requestId: request.requestId,
						type: 'result',
						method: request.method,
						result: transactionHash,
					})
					return true
				}
				return false
			},
		})

		await withFakeInpageWindow(fakeWindow, 'bridge-replay-annotation', async () => {
			const provider = getPageProvider(fakeWindow)
			assert.deepEqual(await provider.request({ method: 'eth_requestAccounts' }), [account])
			assert.equal(await provider.request({ method: 'eth_sendTransaction', params: [{ from: account }] }), transactionHash)
		})

		const accountRequest = bridgeRequests.find((request) => request.method === 'eth_requestAccounts')
		const transactionRequest = bridgeRequests.find((request) => request.method === 'eth_sendTransaction')
		assert.equal(accountRequest?.replayOnDisconnect, true)
		assert.equal(transactionRequest?.replayOnDisconnect, undefined)
		assert.equal(bridgeRequests.filter((request) => request.internal === true).every((request) => request.replayOnDisconnect === undefined), true)
	})

	test('forwards an approved watch-asset dialog action to the selected signer', async () => {
		const signerRequests: SignerRequest[] = []
		let signerReply: unknown
		let signerProviderGeneration: number | undefined
		const { fakeWindow, sendBackgroundMessage } = createFakeWindow({
			handleRequest: (request, sendBackgroundMessageForRequest) => {
				if (request.method === 'connected_to_signer') {
					const generation = request.params?.[2]
					if (typeof generation === 'number') signerProviderGeneration = generation
					return false
				}
				if (request.method !== 'signer_reply') return false
				signerReply = request.params?.[0]
				sendBackgroundMessageForRequest({
					interceptorApproved: true,
					requestId: request.requestId,
					type: 'result',
					method: 'signer_reply',
					result: '0x',
				})
				return true
			},
			handleSignerRequest: (request) => {
				signerRequests.push(request)
				return true
			},
		})
		const parameters = {
			type: 'ERC20',
			options: { address: '0x1111111111111111111111111111111111111111', chainId: 1 },
		}

		await withFakeInpageWindow(fakeWindow, 'watch-asset-forward', async () => {
			await waitFor(() => signerProviderGeneration !== undefined)
			if (signerProviderGeneration === undefined) throw new Error('Missing signer provider generation')
			sendBackgroundMessage({
				interceptorApproved: true,
				type: 'result',
				method: 'request_signer_to_wallet_watchAsset',
				result: {
					parameters,
					uniqueRequestIdentifier: { requestId: 91, requestSocket: { tabId: 7, connectionName: '0x3' } },
					signerIdentity: {
						tabId: 7,
						connectionName: '0x3',
						ownerGeneration: 2,
						signerProviderGeneration,
					},
				},
			})
			await waitFor(() => signerRequests.some(({ method }) => method === 'wallet_watchAsset'))
			await waitFor(() => signerReply !== undefined)
		})

		assert.deepEqual(signerRequests.find(({ method }) => method === 'wallet_watchAsset'), {
			method: 'wallet_watchAsset',
			params: parameters,
		})
		if (!isSignerReplyCandidate(signerReply) || !isForwardRequestCandidate(signerReply.forwardRequest)) throw new Error('Malformed signer reply')
		assert.equal(signerReply.success, true)
		assert.equal(signerReply.forwardRequest.method, 'wallet_watchAsset')
		assert.deepEqual(signerReply.forwardRequest.params, {
			parameters,
			uniqueRequestIdentifier: { requestId: 91, requestSocket: { tabId: 7, connectionName: '0x3' } },
			signerIdentity: {
				tabId: 7,
				connectionName: '0x3',
				ownerGeneration: 2,
				signerProviderGeneration,
			},
		})
	})

	test('accepts MetaMask by-name wallet_watchAsset parameters from webpages', async () => {
		let capturedRequest: InpageRequest | undefined
		const { fakeWindow, sendBackgroundMessage } = createFakeWindow({
			handleRequest: (request) => {
				if (request.method !== 'wallet_watchAsset') return false
				capturedRequest = request
				return true
			},
		})
		const parameters = {
			type: 'ERC20',
			options: { address: '0x1111111111111111111111111111111111111111', chainId: 1 },
		}

		await withFakeInpageWindow(fakeWindow, 'watch-asset-named-params', async () => {
			const provider = getPageProvider(fakeWindow)
			const resultPromise = provider.request({ method: 'wallet_watchAsset', params: parameters })
			await waitFor(() => capturedRequest !== undefined)
			assert.deepEqual(capturedRequest?.params, [parameters])
			if (capturedRequest === undefined) throw new Error('Expected a captured wallet_watchAsset request')
			sendBackgroundMessage({ interceptorApproved: true, requestId: capturedRequest.requestId, type: 'result', method: 'wallet_watchAsset', result: true })
			assert.equal(await resultPromise, true)
		})
	})

	test('rejects named parameters for methods that only accept positional parameters', async () => {
		const { fakeWindow } = createFakeWindow()

		await withFakeInpageWindow(fakeWindow, 'unsupported-named-params', async () => {
			const provider = getPageProvider(fakeWindow)
			await assert.rejects(
				async () => await provider.request({ method: 'eth_chainId', params: {} }),
				(error: unknown) => isRpcErrorCandidate(error)
					&& error.code === -32602
					&& error.message === 'Named parameters are not supported for eth_chainId.',
			)
		})
	})

	test('ignores replayed terminal replies after the original request settles', async () => {
		let capturedRequest: InpageRequest | undefined
		const { fakeWindow, interceptorErrorPayloads, sendBackgroundMessage } = createFakeWindow({
			handleRequest: (request) => {
				if (request.method !== 'eth_sendTransaction') return false
				capturedRequest = request
				return true
			},
		})

		await withFakeInpageWindow(fakeWindow, 'terminal-reply-replay', async () => {
			const provider = getPageProvider(fakeWindow)
			const requestPromise = provider.request({ method: 'eth_sendTransaction', params: [{ from: '0x1111111111111111111111111111111111111111' }] })
			await waitFor(() => capturedRequest !== undefined)
			const request = capturedRequest
			if (request === undefined) throw new Error('request was not captured')
			const rejection = {
				interceptorApproved: true,
				requestId: request.requestId,
				type: 'result',
				method: request.method,
				error: { code: 4001, message: 'User denied transaction signature' },
			}
			sendBackgroundMessage(rejection)
			await assert.rejects(async () => await requestPromise, (error: unknown) => isRpcErrorCandidate(error) && error.code === 4001)

			sendBackgroundMessage(rejection)
			await waitOneEventLoopTurn()
			assert.deepEqual(interceptorErrorPayloads, [])
		})
	})

	test('normalizes object-valued MetaMask rejection data before sending signer_reply', async () => {
		const signerReplies: unknown[] = []
		const { fakeWindow } = createFakeWindow({
			handleRequest: (request, sendBackgroundMessageForRequest) => {
				if (request.method === 'eth_sendTransaction') {
					sendBackgroundMessageForRequest({
						interceptorApproved: true,
						requestId: request.requestId,
						type: 'forwardToSigner',
						method: request.method,
						params: request.params,
					})
					return true
				}
				if (request.method !== 'signer_reply') return false
				signerReplies.push(request.params?.[0])
				sendBackgroundMessageForRequest({
					interceptorApproved: true,
					requestId: request.requestId,
					type: 'result',
					method: 'signer_reply',
					result: '0x',
				})
				return true
			},
			handleSignerRequest: ({ method }) => {
				if (method === 'eth_sendTransaction') return Promise.reject({
					code: 4001,
					message: 'MetaMask Tx Signature: User denied transaction signature.',
					data: { location: 'confirmation', cause: null },
				})
				return undefined
			},
		})

		await withFakeInpageWindow(fakeWindow, 'metamask-rejection-object-data', async () => {
			void getPageProvider(fakeWindow).request({ method: 'eth_sendTransaction', params: [{ from: '0x1111111111111111111111111111111111111111' }] })
			await waitFor(() => signerReplies.length === 1)
		})

		const signerReply = signerReplies[0]
		if (!isSignerReplyCandidate(signerReply) || !isRpcErrorCandidate(signerReply.error)) throw new Error('Malformed signer reply')
		assert.equal(signerReply.success, false)
		assert.equal(typeof signerReply.signerProviderGeneration, 'number')
		assert.deepEqual(signerReply.error, {
			code: 4001,
			message: 'MetaMask Tx Signature: User denied transaction signature.',
		})
		const { SignerReply } = await import('../../app/ts/types/interceptor-messages.js')
		assert.doesNotThrow(() => SignerReply.parse({ method: 'signer_reply', params: [signerReply] }))
	})

	test('preserves string JSON-RPC error data from background replies', async () => {
		const revertData = '0x08c379a0'
		const { fakeWindow, signerRequests } = createFakeWindow({
			handleRequest: (request, sendBackgroundMessage) => {
				if (request.method !== 'eth_call') return false
				sendBackgroundMessage({
					interceptorApproved: true,
					requestId: request.requestId,
					type: 'result',
					method: 'eth_call',
					error: {
						code: -32000,
						message: 'execution reverted',
						data: revertData,
					},
				})
				return true
			},
		})

		await withFakeInpageWindow(fakeWindow, 'json-rpc-error-data', async () => {
			await waitFor(() => signerRequests.length >= 1)
			const provider = getPageProvider(fakeWindow)
			await assert.rejects(
				provider.request({ method: 'eth_call', params: [] }),
				(error: unknown) => {
					if (!isRpcErrorCandidate(error)) return false
					assert.equal(error.code, -32000)
					assert.equal(error.message, 'execution reverted')
					assert.equal(error.data, revertData)
					return true
				},
			)
		})
	})

	test('settles a forwarded storage read directly from the signer reply', async () => {
		const storageValue = `0x${ '42'.padStart(64, '0') }`
		const storageParams: readonly string[] = ['0xE592427A0AEce92De3Edee1F18E0157C05861564', '0x0', 'latest']
		const forwardedSignerRequests: SignerRequest[] = []
		const { fakeWindow } = createFakeWindow({
			handleRequest: (request, sendBackgroundMessage) => {
				if (request.method !== 'eth_getStorageAt') return false
				sendBackgroundMessage({
					interceptorApproved: true,
					requestId: request.requestId,
					type: 'forwardToSigner',
					method: request.method,
					params: request.params,
					replyWithSignersReply: true,
				})
				return true
			},
			handleSignerRequest: (request) => {
				if (request.method !== 'eth_getStorageAt') return undefined
				forwardedSignerRequests.push(request)
				return storageValue
			},
		})

		await withFakeInpageWindow(fakeWindow, 'forwarded-storage-read', async () => {
			const provider = getPageProvider(fakeWindow)
			assert.equal(await provider.request({ method: 'eth_getStorageAt', params: storageParams }), storageValue)
		})
		assert.deepEqual(forwardedSignerRequests, [{ method: 'eth_getStorageAt', params: storageParams }])
	})

	test('preserves string JSON-RPC error data from signer replies', async () => {
		const revertData = '0x08c379a0'
		const { fakeWindow, signerRequests } = createFakeWindow({
			handleRequest: (request, sendBackgroundMessage) => {
				if (request.method !== 'eth_call') return false
				sendBackgroundMessage({
					interceptorApproved: true,
					requestId: request.requestId,
					type: 'forwardToSigner',
					method: 'eth_call',
					params: request.params,
					replyWithSignersReply: true,
				})
				return true
			},
			handleSignerRequest: ({ method }) => {
				if (method !== 'eth_call') return undefined
				throw { code: -32000, message: 'execution reverted', data: revertData }
			},
		})

		await withFakeInpageWindow(fakeWindow, 'signer-json-rpc-error-data', async () => {
			await waitFor(() => signerRequests.length >= 1)
			const provider = getPageProvider(fakeWindow)
			await assert.rejects(
				provider.request({ method: 'eth_call', params: [] }),
				(error: unknown) => {
					if (!isRpcErrorCandidate(error)) return false
					assert.equal(error.code, -32000)
					assert.equal(error.message, 'execution reverted')
					assert.equal(error.data, revertData)
					return true
				},
			)
		})
	})

})
