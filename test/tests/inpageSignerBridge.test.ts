import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { createFakeWindow, withFakeInpageWindow, type InpageRequest, type SignerRequest } from './inpageSignerBridgeHarness.js'
import { waitFor } from '../harness/async.js'
import { isRecord } from '../harness/assertions.js'

function createLockedCompatibilitySigner() {
	const baseSigner = {
		isMetaMask: true,
		isConnected: () => true,
		request: async ({ method }: { method: string }) => {
			switch (method) {
				case 'eth_chainId':
					return '0x1'
				default:
					throw new Error(`Unexpected signer request: ${ method }`)
			}
		},
		on: () => baseSigner,
		removeListener: () => baseSigner,
	}

	Object.defineProperty(baseSigner, 'selectedAddress', {
		configurable: false,
		enumerable: true,
		get: () => undefined,
	})

	return baseSigner
}

function createConfigurableGetterOnlyCompatibilitySigner() {
	const baseSigner = {
		isMetaMask: true,
		isConnected: () => true,
		request: async ({ method }: { method: string }) => {
			switch (method) {
				case 'eth_chainId':
					return '0x1'
				default:
					throw new Error(`Unexpected signer request: ${ method }`)
			}
		},
		on: () => baseSigner,
		removeListener: () => baseSigner,
	}

	Object.defineProperty(baseSigner, 'selectedAddress', {
		configurable: true,
		enumerable: true,
		get: () => undefined,
	})

	return baseSigner
}

describe('inpage signer bridge', () => {

	for (const blockedStage of ['wallet', 'background']) {
		test(`publishes signer accounts while ${ blockedStage } chain initialization is pending`, async () => {
			let finishChain: (() => void) | undefined
			let chainInitializationPending = false
			const chainReply = new Promise<string>((resolve) => { finishChain = () => resolve('0x1') })
			const { fakeWindow, backgroundEthAccountsReplies, sendBackgroundMessage, signerRequests } = createFakeWindow({
				handleSignerRequest: ({ method }) => {
					if (method !== 'eth_chainId' || blockedStage !== 'wallet') return undefined
					chainInitializationPending = true
					return chainReply
				},
				handleRequest: (request, reply) => {
					if (request.method !== 'signer_chainChanged' || blockedStage !== 'background') return false
					chainInitializationPending = true
					finishChain = () => reply({ interceptorApproved: true, requestId: request.requestId, type: 'result', method: request.method, result: '0x' })
					return true
				},
			})
			await withFakeInpageWindow(fakeWindow, `accounts-independent-of-chain-${ blockedStage }`, async () => {
				try {
					await waitFor(() => chainInitializationPending)
					sendBackgroundMessage({ interceptorApproved: true, type: 'result', method: 'request_signer_to_eth_accounts', result: [] })
					await waitFor(() => signerRequests.includes('eth_accounts'))
					await waitFor(() => backgroundEthAccountsReplies.length === 1)
					assert.deepEqual(backgroundEthAccountsReplies[0], { type: 'success', accounts: ['0x1111111111111111111111111111111111111111'], requestAccounts: false, signerProviderGeneration: 2 })
				} finally {
					finishChain?.()
				}
			})
		})
	}

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
			const sendAsync = Reflect.get(fakeWindow.ethereum, 'sendAsync')
			if (typeof sendAsync !== 'function') throw new Error('sendAsync is unavailable')
			const callbackArguments = await new Promise<readonly [unknown, unknown]>((resolve) => {
				void sendAsync({ id: 71, method: 'eth_chainId', params: [] }, (error: unknown, response: unknown) => resolve([error, response]))
			})

			assert.equal(callbackArguments[0], null)
			const response = callbackArguments[1]
			if (!isRecord(response) || !isRecord(response.error)) throw new Error('Malformed JSON-RPC error response')
			assert.equal(response.id, 71)
			assert.equal(response.error.code, -32000)
			assert.equal(response.error.message, 'RPC failed')
		})
	})

	test('returns bridge transport failures through the sendAsync error argument', async () => {
		const { fakeWindow, signerRequests } = createFakeWindow()

		await withFakeInpageWindow(fakeWindow, 'send-async-transport-error', async () => {
			await waitFor(() => signerRequests.includes('eth_chainId'))
			await new Promise((resolve) => setTimeout(resolve, 0))
			const sendAsync = Reflect.get(fakeWindow.ethereum, 'sendAsync')
			if (typeof sendAsync !== 'function') throw new Error('sendAsync is unavailable')
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
			const sendAsync = Reflect.get(fakeWindow.ethereum, 'sendAsync')
			if (typeof sendAsync !== 'function') throw new Error('sendAsync is unavailable')
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
			const provider = fakeWindow.ethereum as { request: (payload: { method: string, params?: readonly unknown[] }) => Promise<unknown> }
			assert.deepEqual(await provider.request({ method: 'eth_requestAccounts' }), [account])
			assert.equal(await provider.request({ method: 'eth_sendTransaction', params: [{ from: account }] }), transactionHash)
		})

		const accountRequest = bridgeRequests.find((request) => request.method === 'eth_requestAccounts')
		const transactionRequest = bridgeRequests.find((request) => request.method === 'eth_sendTransaction')
		assert.equal(accountRequest?.replayOnDisconnect, true)
		assert.equal(transactionRequest?.replayOnDisconnect, undefined)
		assert.equal(bridgeRequests.filter((request) => request.internal === true).every((request) => request.replayOnDisconnect === undefined), true)
	})

	test('settles signer account discovery when no signer initializes', async () => {
		const connectedToSignerParams: unknown[][] = []
		const { fakeWindow, backgroundEthAccountsReplies, sendBackgroundMessage } = createFakeWindow({
			handleRequest: (request, sendBackgroundReply) => {
				if (request.method !== 'connected_to_signer') return false
				connectedToSignerParams.push(request.params ?? [])
				sendBackgroundReply({
					interceptorApproved: true,
					requestId: request.requestId,
					type: 'result',
					method: 'connected_to_signer',
					result: { metamaskCompatibilityMode: true },
				})
				return true
			},
		})
		Reflect.deleteProperty(fakeWindow, 'ethereum')

		await withFakeInpageWindow(fakeWindow, 'unavailable-signer-account-reply', async () => {
			sendBackgroundMessage({
				interceptorApproved: true,
				type: 'result',
				method: 'request_signer_to_eth_requestAccounts',
				result: [],
			})
			await waitFor(() => backgroundEthAccountsReplies.length === 1, { timeoutMs: 3500 })
		})

		assert.deepEqual(backgroundEthAccountsReplies, [{
			type: 'error',
			requestAccounts: true,
			signerProviderGeneration: 1,
			signerUnavailable: true,
			error: { code: 4900, message: 'No signer wallet is available to this page. Enable your wallet extension for this site, then try again.' },
		}])
		assert.deepEqual(connectedToSignerParams, [[false, 'NoSigner', 1]])
	})

	test('preserves large chain IDs in the legacy networkVersion compatibility property', async () => {
		const largeChainId = '0x20000000000001'
		const { fakeWindow } = createFakeWindow({
			handleRequest: (request, sendBackgroundReply) => {
				if (request.method === 'connected_to_signer') {
					sendBackgroundReply({
						interceptorApproved: true,
						requestId: request.requestId,
						type: 'result',
						method: request.method,
						result: { metamaskCompatibilityMode: true },
					})
					return true
				}
				if (request.method !== 'eth_chainId') return false
				sendBackgroundReply({
					interceptorApproved: true,
					requestId: request.requestId,
					type: 'result',
					method: request.method,
					result: largeChainId,
				})
				return true
			},
		})
		Reflect.deleteProperty(fakeWindow, 'ethereum')

		await withFakeInpageWindow(fakeWindow, 'large-network-version', async () => {
			const provider = Reflect.get(fakeWindow, 'ethereum')
			if (!isRecord(provider) || typeof provider.request !== 'function') throw new Error('Interceptor provider was not installed')
			assert.equal(await provider.request({ method: 'eth_chainId' }), largeChainId)
			assert.equal(provider.networkVersion, '9007199254740993')
		})
	})

	test('reports a fresh signer epoch when the background requests reconnect status', async () => {
		const connectedToSignerParams: unknown[][] = []
		const { fakeWindow, sendBackgroundMessage } = createFakeWindow({
			handleRequest: (request, sendBackgroundReply) => {
				if (request.method !== 'connected_to_signer') return false
				connectedToSignerParams.push(request.params ?? [])
				sendBackgroundReply({
					interceptorApproved: true,
					requestId: request.requestId,
					type: 'result',
					method: 'connected_to_signer',
					result: { metamaskCompatibilityMode: true },
				})
				return true
			},
		})

		await withFakeInpageWindow(fakeWindow, 'explicit-signer-status-handshake', async () => {
			await waitFor(() => connectedToSignerParams.length === 1)
			sendBackgroundMessage({
				interceptorApproved: true,
				type: 'result',
				method: 'request_signer_connection_status',
				result: [],
			})
			await waitFor(() => connectedToSignerParams.length === 2)
		})

		const firstGeneration = connectedToSignerParams[0]?.[2]
		const secondGeneration = connectedToSignerParams[1]?.[2]
		assert.equal(connectedToSignerParams[1]?.[1], 'MetaMask')
		assert.equal(typeof firstGeneration, 'number')
		assert.equal(typeof secondGeneration, 'number')
		if (typeof firstGeneration !== 'number' || typeof secondGeneration !== 'number') throw new Error('Missing signer provider generation')
		assert.equal(secondGeneration > firstGeneration, true)
	})

	test('reports reconnect status without waiting for a lost previous status reply', async () => {
		const connectedToSignerParams: unknown[][] = []
		const { backgroundEthAccountsReplies, fakeWindow, sendBackgroundMessage, signerRequests } = createFakeWindow({
			handleRequest: (request, sendBackgroundReply) => {
				if (request.method !== 'connected_to_signer') return false
				connectedToSignerParams.push(request.params ?? [])
				if (connectedToSignerParams.length === 1) return true
				sendBackgroundReply({
					interceptorApproved: true,
					requestId: request.requestId,
					type: 'result',
					method: 'connected_to_signer',
					result: { metamaskCompatibilityMode: true },
				})
				return true
			},
		})

		await withFakeInpageWindow(fakeWindow, 'lost-signer-status-reply', async () => {
			await waitFor(() => connectedToSignerParams.length === 1)
			sendBackgroundMessage({
				interceptorApproved: true,
				type: 'result',
				method: 'request_signer_to_eth_accounts',
				result: [],
			})
			await new Promise((resolve) => setTimeout(resolve, 0))
			assert.equal(backgroundEthAccountsReplies.length, 0)
			sendBackgroundMessage({
				interceptorApproved: true,
				type: 'result',
				method: 'request_signer_connection_status',
				result: [],
			})
			await waitFor(() => connectedToSignerParams.length === 2)
			await waitFor(() => signerRequests.includes('eth_chainId'))
			await waitFor(() => backgroundEthAccountsReplies.length === 1)
		})

		const firstGeneration = connectedToSignerParams[0]?.[2]
		const secondGeneration = connectedToSignerParams[1]?.[2]
		assert.equal(typeof firstGeneration, 'number')
		assert.equal(typeof secondGeneration, 'number')
		if (typeof firstGeneration !== 'number' || typeof secondGeneration !== 'number') throw new Error('Missing signer provider generation')
		assert.equal(secondGeneration > firstGeneration, true)
	})

	test('settles a pending chain switch when the signer provider changes', async () => {
		const chainSwitchReplies: unknown[] = []
		let chainSwitchRequestCount = 0
		const { fakeWindow, emitSignerEvent, sendBackgroundMessage } = createFakeWindow({
			handleRequest: (request, sendBackgroundReply) => {
				if (request.method !== 'wallet_switchEthereumChain_reply') return false
				chainSwitchReplies.push(request.params?.[0])
				sendBackgroundReply({
					interceptorApproved: true,
					requestId: request.requestId,
					type: 'result',
					method: 'wallet_switchEthereumChain_reply',
					result: '0x',
				})
				return true
			},
			handleSignerRequest: ({ method }) => {
				if (method !== 'wallet_switchEthereumChain') return undefined
				chainSwitchRequestCount += 1
				return new Promise<never>(() => undefined)
			},
		})

		await withFakeInpageWindow(fakeWindow, 'chain-switch-provider-change', async () => {
			sendBackgroundMessage({
				interceptorApproved: true,
				type: 'result',
				method: 'request_signer_to_wallet_switchEthereumChain',
				walletSwitchRequestId: 'test-switch',
				result: '0x2',
			})
			await waitFor(() => chainSwitchRequestCount === 1)
			emitSignerEvent('connect', { chainId: '0x1' })
			await waitFor(() => chainSwitchReplies.length === 1)
		})

		const reply = chainSwitchReplies[0]
		if (!isRecord(reply) || !isRecord(reply.error)) throw new Error('Malformed chain switch reply')
		assert.equal(reply.accept, false)
		assert.equal(reply.chainId, '0x2')
		assert.equal(reply.walletSwitchRequestId, 'test-switch')
		assert.equal(reply.error.code, 4900)
		assert.equal(reply.error.message, 'Signer connection changed before the previous wallet replied.')
	})

	test('settles a chain switch for an unexpected signer error', async () => {
		const chainSwitchReplies: unknown[] = []
		const { fakeWindow, sendBackgroundMessage } = createFakeWindow({
			handleRequest: (request, sendBackgroundReply) => {
				if (request.method !== 'wallet_switchEthereumChain_reply') return false
				chainSwitchReplies.push(request.params?.[0])
				sendBackgroundReply({
					interceptorApproved: true,
					requestId: request.requestId,
					type: 'result',
					method: 'wallet_switchEthereumChain_reply',
					result: '0x',
				})
				return true
			},
			handleSignerRequest: ({ method }) => method === 'wallet_switchEthereumChain'
				? Promise.reject({ code: -32000, message: 'Unexpected signer failure' })
				: undefined,
		})

		await withFakeInpageWindow(fakeWindow, 'chain-switch-unexpected-error', async () => {
			sendBackgroundMessage({
				interceptorApproved: true,
				type: 'result',
				method: 'request_signer_to_wallet_switchEthereumChain',
				walletSwitchRequestId: 'test-switch',
				result: '0x2',
			})
			await waitFor(() => chainSwitchReplies.length === 1)
		})

		const reply = chainSwitchReplies[0]
		if (!isRecord(reply) || !isRecord(reply.error)) throw new Error('Malformed chain switch reply')
		assert.equal(reply.accept, false)
		assert.equal(reply.error.code, -32000)
		assert.equal(reply.error.message, 'Unexpected signer failure')
	})

	test('settles a chain switch when no signer is injected', async () => {
		const chainSwitchReplies: unknown[] = []
		const { fakeWindow, sendBackgroundMessage } = createFakeWindow({
			handleRequest: (request, sendBackgroundReply) => {
				if (request.method !== 'wallet_switchEthereumChain_reply') return false
				chainSwitchReplies.push(request.params?.[0])
				sendBackgroundReply({
					interceptorApproved: true,
					requestId: request.requestId,
					type: 'result',
					method: 'wallet_switchEthereumChain_reply',
					result: '0x',
				})
				return true
			},
		})
		Reflect.deleteProperty(fakeWindow, 'ethereum')

		await withFakeInpageWindow(fakeWindow, 'chain-switch-no-signer', async () => {
			sendBackgroundMessage({
				interceptorApproved: true,
				type: 'result',
				method: 'request_signer_to_wallet_switchEthereumChain',
				walletSwitchRequestId: 'test-switch',
				result: '0x2',
			})
			await waitFor(() => chainSwitchReplies.length === 1)
		})

		const reply = chainSwitchReplies[0]
		if (!isRecord(reply) || !isRecord(reply.error)) throw new Error('Malformed chain switch reply')
		assert.equal(reply.accept, false)
		assert.equal(reply.error.code, 4900)
		assert.match(String(reply.error.message), /No signer wallet is available/)
	})

	test('keeps wallet switch request IDs when replies arrive out of order', async () => {
		const replies: unknown[] = []
		const complete: ((value: unknown) => void)[] = []
		const { fakeWindow, sendBackgroundMessage } = createFakeWindow({
			handleRequest: (request, respond) => {
				if (request.method !== 'wallet_switchEthereumChain_reply') return false
				replies.push(request.params?.[0])
				respond({ interceptorApproved: true, type: 'result', requestId: request.requestId, method: request.method, result: '0x' })
				return true
			},
			handleSignerRequest: ({ method }) => method === 'wallet_switchEthereumChain' ? new Promise(resolve => complete.push(resolve)) : undefined,
		})
		await withFakeInpageWindow(fakeWindow, 'out-of-order-wallet-switches', async () => {
			for (const walletSwitchRequestId of ['expired', 'current']) {
				sendBackgroundMessage({ interceptorApproved: true, type: 'result', method: 'request_signer_to_wallet_switchEthereumChain', result: '0x2', walletSwitchRequestId })
			}
			await waitFor(() => complete.length === 2)
			complete[1]?.(null)
			await waitFor(() => replies.length === 1)
			complete[0]?.(null)
			await waitFor(() => replies.length === 2)
		})
		assert.deepEqual(replies.map(reply => isRecord(reply) ? [reply.walletSwitchRequestId, reply.accept] : undefined), [['current', true], ['expired', true]])
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
		if (!isRecord(signerReply) || !isRecord(signerReply.forwardRequest)) throw new Error('Malformed signer reply')
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
			const provider = fakeWindow.ethereum as { request: (payload: { method: string, params: Readonly<Record<string, unknown>> }) => Promise<unknown> }
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
			const provider = fakeWindow.ethereum as { request: (payload: { method: string, params: Readonly<Record<string, unknown>> }) => Promise<unknown> }
			await assert.rejects(
				async () => await provider.request({ method: 'eth_chainId', params: {} }),
				(error: unknown) => isRecord(error)
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
			const provider = fakeWindow.ethereum as { request: (payload: { method: string, params?: readonly unknown[] }) => Promise<unknown> }
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
			await assert.rejects(async () => await requestPromise, (error: unknown) => isRecord(error) && error.code === 4001)

			sendBackgroundMessage(rejection)
			await new Promise((resolve) => setTimeout(resolve, 0))
			assert.deepEqual(interceptorErrorPayloads, [])
		})
	})

	test('avoid hidden signer account sync on connect and preserve explicit account replies', async () => {
		const previousWindow = (globalThis as { window?: unknown }).window
		const previousCustomEvent = (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent
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
		;(globalThis as unknown as { window: typeof fakeWindow }).window = fakeWindow
		if (typeof (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent !== 'function') {
			;(globalThis as { CustomEvent: typeof CustomEvent }).CustomEvent = class CustomEvent<T = unknown> extends Event {
				public detail: T
				constructor(type: string, init?: CustomEventInit<T>) {
					super(type)
					this.detail = init?.detail as T
				}
				public initCustomEvent(): void { return undefined }
			}
		}

		try {
			await import('../../app/inpage/ts/inpage.js')
			await waitFor(() => signerRequests.length >= 1)
			assert.deepEqual(signerRequests, ['eth_chainId'])
			assert.strictEqual(fakeWindow.dispatchEvent, originalDispatchEvent)
			const provider = fakeWindow.ethereum as {
				request: (payload: { method: string, params?: readonly unknown[] }) => Promise<unknown>
				send: (payload: { id: string | number | null, method: string, params: readonly unknown[] }, callback?: undefined) => { jsonrpc: '2.0', id: string | number | null, result: unknown }
				sendAsync: (payload: unknown, callback: (error: unknown, response: unknown) => void) => Promise<void>
				on: (eventName: string, callback: (value: unknown) => void) => void
			}
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
				provider.sendAsync([
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
			assert.deepEqual((backgroundEthAccountsReplies[0] as { accounts?: unknown }).accounts, signerAccounts)

			sendBackgroundMessage({
				interceptorApproved: true,
				type: 'result',
				method: 'request_signer_to_eth_requestAccounts',
				result: [],
			})
			await waitFor(() => signerRequests.filter((method) => method === 'eth_requestAccounts').length === 1)
			assert.deepEqual(signerRequests, ['eth_chainId', 'eth_accounts', 'eth_requestAccounts'])
			await waitFor(() => backgroundEthAccountsReplies.length === 2)
			assert.deepEqual((backgroundEthAccountsReplies[1] as { accounts?: unknown }).accounts, signerAccounts)
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
			await new Promise((resolve) => setTimeout(resolve, 0))
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
			;(fakeWindow as { ethereum: typeof lateSigner }).ethereum = lateSigner
			fakeWindow.dispatchEvent({ type: 'ethereum#initialized' })
			await waitFor(() => lateSignerRequests.length >= 1)
			assert.equal(lateSignerRequests[0], 'eth_chainId')
			assert.equal((fakeWindow.ethereum as { isInterceptor?: boolean }).isInterceptor, true)
			assert.strictEqual(fakeWindow.dispatchEvent, originalDispatchEvent)
		} finally {
			;(globalThis as { window?: unknown }).window = previousWindow
			if (previousCustomEvent === undefined) {
				delete (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent
			} else {
				;(globalThis as { CustomEvent: typeof CustomEvent }).CustomEvent = previousCustomEvent
			}
		}
	})

	test('keeps standalone eth_accounts replies free of console warnings', async () => {
		const signerAccount = '0x1111111111111111111111111111111111111111'
		const warnings: unknown[][] = []
		const previousWarn = console.warn
		console.warn = (...args: unknown[]) => { warnings.push(args) }
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
				const provider = fakeWindow.ethereum as {
					request: (payload: { method: string, params?: readonly unknown[] }) => Promise<unknown>
				}
				assert.deepEqual(await provider.request({ method: 'eth_accounts' }), [signerAccount])
			})
			assert.equal(warnings.length, 0)
		} finally {
			console.warn = previousWarn
		}
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
			void fakeWindow.ethereum.request({ method: 'eth_sendTransaction', params: [{ from: '0x1111111111111111111111111111111111111111' }] })
			await waitFor(() => signerReplies.length === 1)
		})

		const signerReply = signerReplies[0]
		if (!isRecord(signerReply) || !isRecord(signerReply.error)) throw new Error('Malformed signer reply')
		assert.equal(signerReply.success, false)
		assert.equal(typeof signerReply.signerProviderGeneration, 'number')
		assert.deepEqual(signerReply.error, {
			code: 4001,
			message: 'MetaMask Tx Signature: User denied transaction signature.',
		})
		const { SignerReply } = await import('../../app/ts/types/interceptor-messages.js')
		assert.doesNotThrow(() => SignerReply.parse({ method: 'signer_reply', params: [signerReply] }))
	})

	test('keeps signer selectedAddress mutations hidden until Interceptor account replay', async () => {
		const signerAccount = '0x1111111111111111111111111111111111111111'
		let mutationAttempted = false
		let pendingRequest: InpageRequest | undefined
		let pendingSendBackgroundMessage: ((data: unknown) => void) | undefined
		let exposedWindow: ReturnType<typeof createFakeWindow>['fakeWindow'] | undefined
		const createdWindow = createFakeWindow({
			signerInitialSelectedAddress: signerAccount,
			handleRequest: (request, sendBackgroundMessageForRequest) => {
				if (request.method !== 'eth_requestAccounts') return false
				if (exposedWindow === undefined) throw new Error('fake window was not initialized')
				try {
					;(exposedWindow.ethereum as { selectedAddress?: string }).selectedAddress = signerAccount
				} catch (error: unknown) {
					if (!(error instanceof TypeError)) throw error
				}
				if ('web3' in exposedWindow && exposedWindow.web3 !== undefined) {
					try {
						;(exposedWindow.web3 as { accounts?: readonly string[] }).accounts = [signerAccount]
					} catch (error: unknown) {
						if (!(error instanceof TypeError)) throw error
					}
				}
				mutationAttempted = true
				pendingRequest = request
				pendingSendBackgroundMessage = sendBackgroundMessageForRequest
				return true
			},
		})
		const { fakeWindow, signerRequests, sendBackgroundMessage } = createdWindow
		exposedWindow = fakeWindow

		await withFakeInpageWindow(fakeWindow, 'selected-address-mutation-mask', async () => {
			const provider = fakeWindow.ethereum as {
				request: (payload: { method: string, params?: readonly unknown[] }) => Promise<unknown>
				send: (payload: { id: string | number | null, method: string, params: readonly unknown[] }, callback?: undefined) => { readonly result: unknown }
				on: (eventName: string, callback: (value: unknown) => void) => void
				isConnected: () => boolean
				selectedAddress?: string
			}
			await waitFor(() => signerRequests.includes('eth_chainId'))
			assert.equal(provider.selectedAddress, undefined)
			assert.deepEqual(provider.send({ id: 1, method: 'eth_accounts', params: [] }).result, [])
			assert.deepEqual((fakeWindow as { web3?: { accounts?: unknown } }).web3?.accounts, [])

			const requestPromise = provider.request({ method: 'eth_requestAccounts' })
			await waitFor(() => mutationAttempted)
			assert.equal(provider.selectedAddress, undefined)
			assert.deepEqual(provider.send({ id: 2, method: 'eth_accounts', params: [] }).result, [])
			assert.deepEqual((fakeWindow as { web3?: { accounts?: unknown } }).web3?.accounts, [])
			if (pendingRequest === undefined || pendingSendBackgroundMessage === undefined) throw new Error('eth_requestAccounts was not captured')

			pendingSendBackgroundMessage({
				interceptorApproved: true,
				requestId: pendingRequest.requestId,
				type: 'result',
				method: 'connect',
				result: ['0x1'],
			})
			pendingSendBackgroundMessage({
				interceptorApproved: true,
				requestId: pendingRequest.requestId,
				type: 'result',
				method: 'accountsChanged',
				result: [signerAccount],
			})
			pendingSendBackgroundMessage({
				interceptorApproved: true,
				requestId: pendingRequest.requestId,
				type: 'result',
				method: 'eth_accounts',
				result: [signerAccount],
			})
			const accountReply = await requestPromise
			assert.deepEqual(accountReply, [signerAccount])
			assert.equal(provider.selectedAddress, signerAccount)
			pendingSendBackgroundMessage({
				interceptorApproved: true,
				requestId: pendingRequest.requestId,
				type: 'result',
				method: 'accountsChanged',
				result: [signerAccount],
			})
			await waitFor(() => provider.selectedAddress === signerAccount)
			assert.deepEqual(provider.send({ id: 3, method: 'eth_accounts', params: [] }).result, [signerAccount])
			assert.deepEqual((fakeWindow as { web3?: { accounts?: unknown } }).web3?.accounts, [signerAccount])

			const accountEvents: unknown[] = []
			const disconnectEvents: unknown[] = []
			provider.on('accountsChanged', (accounts) => accountEvents.push(accounts))
			provider.on('disconnect', (error) => disconnectEvents.push(error))
			sendBackgroundMessage({
				interceptorApproved: true,
				type: 'result',
				method: 'accountsChanged',
				result: [],
			})
			sendBackgroundMessage({
				interceptorApproved: true,
				type: 'result',
				method: 'disconnect',
				result: [],
			})
			await waitFor(() => provider.selectedAddress === undefined && !provider.isConnected())
			assert.deepEqual(accountEvents, [[]])
			assert.deepEqual(disconnectEvents, [{ name: 'disconnect', code: 4900, message: 'Provider disconnected from all chains.' }])
			assert.deepEqual(provider.send({ id: 4, method: 'eth_accounts', params: [] }).result, [])
			assert.deepEqual((fakeWindow as { web3?: { accounts?: unknown } }).web3?.accounts, [])
		})
	})

	test('freezes non-configurable writable compatibility properties before signer mutation can expose accounts', async () => {
		const signerAccount = '0x1111111111111111111111111111111111111111'
		let mutationAttempted = false
		let pendingRequest: InpageRequest | undefined
		let pendingSendBackgroundMessage: ((data: unknown) => void) | undefined
		let exposedWindow: ReturnType<typeof createFakeWindow>['fakeWindow'] | undefined
		const createdWindow = createFakeWindow({
			handleRequest: (request, sendBackgroundMessageForRequest) => {
				if (request.method !== 'eth_requestAccounts') return false
				if (exposedWindow === undefined) throw new Error('fake window was not initialized')
				try {
					;(exposedWindow.ethereum as { selectedAddress?: string }).selectedAddress = signerAccount
				} catch (error: unknown) {
					if (!(error instanceof TypeError)) throw error
				}
				if ('web3' in exposedWindow && exposedWindow.web3 !== undefined) {
					try {
						;(exposedWindow.web3 as { accounts?: readonly string[] }).accounts = [signerAccount]
					} catch (error: unknown) {
						if (!(error instanceof TypeError)) throw error
					}
				}
				mutationAttempted = true
				pendingRequest = request
				pendingSendBackgroundMessage = sendBackgroundMessageForRequest
				return true
			},
		})
		const { fakeWindow, signerRequests } = createdWindow
		exposedWindow = fakeWindow
		Object.defineProperty(fakeWindow.ethereum, 'selectedAddress', {
			configurable: false,
			enumerable: true,
			value: signerAccount,
			writable: true,
		})
		;(fakeWindow as { web3?: { accounts?: readonly string[], currentProvider: unknown } }).web3 = { accounts: [signerAccount], currentProvider: fakeWindow.ethereum }
		Object.defineProperty((fakeWindow as { web3: { accounts?: readonly string[] } }).web3, 'accounts', {
			configurable: false,
			enumerable: true,
			value: [signerAccount],
			writable: true,
		})

		await withFakeInpageWindow(fakeWindow, 'non-configurable-writable-compatibility-mask', async () => {
			const provider = fakeWindow.ethereum as {
				request: (payload: { method: string, params?: readonly unknown[] }) => Promise<unknown>
				send: (payload: { id: string | number | null, method: string, params: readonly unknown[] }, callback?: undefined) => { readonly result: unknown }
				selectedAddress?: string
			}
			await waitFor(() => signerRequests.includes('eth_chainId'))
			assert.equal(provider.selectedAddress, undefined)
			assert.deepEqual(provider.send({ id: 1, method: 'eth_accounts', params: [] }).result, [])
			assert.deepEqual((fakeWindow as { web3?: { accounts?: unknown } }).web3?.accounts, [])

			const requestPromise = provider.request({ method: 'eth_requestAccounts' })
			await waitFor(() => mutationAttempted)
			assert.equal(provider.selectedAddress, undefined)
			assert.deepEqual(provider.send({ id: 2, method: 'eth_accounts', params: [] }).result, [])
			assert.deepEqual((fakeWindow as { web3?: { accounts?: unknown } }).web3?.accounts, [])
			if (pendingRequest === undefined || pendingSendBackgroundMessage === undefined) throw new Error('eth_requestAccounts was not captured')

			pendingSendBackgroundMessage({
				interceptorApproved: true,
				requestId: pendingRequest.requestId,
				type: 'result',
				method: 'connect',
				result: ['0x1'],
			})
			pendingSendBackgroundMessage({
				interceptorApproved: true,
				requestId: pendingRequest.requestId,
				type: 'result',
				method: 'accountsChanged',
				result: [signerAccount],
			})
			pendingSendBackgroundMessage({
				interceptorApproved: true,
				requestId: pendingRequest.requestId,
				type: 'result',
				method: 'eth_accounts',
				result: [signerAccount],
			})
			assert.deepEqual(await requestPromise, [signerAccount])
			assert.equal(provider.selectedAddress, signerAccount)
			assert.deepEqual((fakeWindow as { web3?: { accounts?: unknown } }).web3?.accounts, [signerAccount])
		})
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
			await new Promise((resolve) => setTimeout(resolve, 0))
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
			const provider = fakeWindow.ethereum as {
				request: (payload: { method: string, params?: readonly unknown[] }) => Promise<unknown>
				on: (eventName: string, callback: (value: unknown) => void) => void
			}
			await waitFor(() => typeof provider.request === 'function')
			await waitFor(() => signerRequests.includes('eth_chainId'))
			sendBackgroundMessage({
				interceptorApproved: true,
				type: 'result',
				method: 'accountsChanged',
				result: [signerAccount],
			})
			await waitFor(() => (fakeWindow.ethereum as { selectedAddress?: string }).selectedAddress === signerAccount)
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
			const provider = fakeWindow.ethereum as {
				request: (payload: { method: string, params?: readonly unknown[] }) => Promise<unknown>
				on: (eventName: string, callback: (value: unknown) => void) => void
			}
			await waitFor(() => typeof provider.request === 'function')
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
			const provider = fakeWindow.ethereum as {
				request: (payload: { method: string, params?: readonly unknown[] }) => Promise<unknown>
				on: (eventName: string, callback: (value: unknown) => void) => void
				isConnected: () => boolean
				selectedAddress?: string
				chainId?: string
			}
			await waitFor(() => typeof provider.request === 'function')
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
			assert.deepEqual((fakeWindow as { web3?: { accounts?: unknown } }).web3?.accounts, [])
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
			await new Promise((resolve) => setTimeout(resolve, 0))
			await new Promise((resolve) => setTimeout(resolve, 0))

			assert.deepEqual(events, [])
			assert.equal(provider.isConnected(), connectedAfterRequest)
			assert.equal(provider.chainId, chainIdAfterRequest)
			assert.equal(provider.selectedAddress, undefined)
			assert.deepEqual((fakeWindow as { web3?: { accounts?: unknown } }).web3?.accounts, [])
		})
	})

	test('preserves string JSON-RPC error data from background replies', async () => {
		const previousWindow = (globalThis as { window?: unknown }).window
		const previousCustomEvent = (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent
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
		;(globalThis as unknown as { window: typeof fakeWindow }).window = fakeWindow
		if (typeof (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent !== 'function') {
			;(globalThis as { CustomEvent: typeof CustomEvent }).CustomEvent = class CustomEvent<T = unknown> extends Event {
				public detail: T
				constructor(type: string, init?: CustomEventInit<T>) {
					super(type)
					this.detail = init?.detail as T
				}
				public initCustomEvent(): void { return undefined }
			}
		}

		try {
			await import('../../app/inpage/ts/inpage.js?json-rpc-error-data')
			await waitFor(() => signerRequests.length >= 1)
			const provider = fakeWindow.ethereum as {
				request: (payload: { method: string, params?: readonly unknown[] }) => Promise<unknown>
			}
			await assert.rejects(
				provider.request({ method: 'eth_call', params: [] }),
				(error: unknown) => {
					if (!isRecord(error)) return false
					assert.equal(error.code, -32000)
					assert.equal(error.message, 'execution reverted')
					assert.equal(error.data, revertData)
					return true
				},
			)
		} finally {
			;(globalThis as { window?: unknown }).window = previousWindow
			if (previousCustomEvent === undefined) {
				delete (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent
			} else {
				;(globalThis as { CustomEvent: typeof CustomEvent }).CustomEvent = previousCustomEvent
			}
		}
	})

	test('settles a forwarded storage read directly from the signer reply', async () => {
		const storageValue = `0x${ '42'.padStart(64, '0') }`
		const storageParams = ['0xE592427A0AEce92De3Edee1F18E0157C05861564', '0x0', 'latest'] as const
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
			const provider = fakeWindow.ethereum as {
				request: (payload: { method: string, params?: readonly unknown[] }) => Promise<unknown>
			}
			assert.equal(await provider.request({ method: 'eth_getStorageAt', params: storageParams }), storageValue)
		})
		assert.deepEqual(forwardedSignerRequests, [{ method: 'eth_getStorageAt', params: storageParams }])
	})

	test('preserves string JSON-RPC error data from signer replies', async () => {
		const previousWindow = (globalThis as { window?: unknown }).window
		const previousCustomEvent = (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent
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
		;(globalThis as unknown as { window: typeof fakeWindow }).window = fakeWindow
		if (typeof (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent !== 'function') {
			;(globalThis as { CustomEvent: typeof CustomEvent }).CustomEvent = class CustomEvent<T = unknown> extends Event {
				public detail: T
				constructor(type: string, init?: CustomEventInit<T>) {
					super(type)
					this.detail = init?.detail as T
				}
				public initCustomEvent(): void { return undefined }
			}
		}

		try {
			await import('../../app/inpage/ts/inpage.js?signer-json-rpc-error-data')
			await waitFor(() => signerRequests.length >= 1)
			const provider = fakeWindow.ethereum as {
				request: (payload: { method: string, params?: readonly unknown[] }) => Promise<unknown>
			}
			await assert.rejects(
				provider.request({ method: 'eth_call', params: [] }),
				(error: unknown) => {
					if (!isRecord(error)) return false
					assert.equal(error.code, -32000)
					assert.equal(error.message, 'execution reverted')
					assert.equal(error.data, revertData)
					return true
				},
			)
		} finally {
			;(globalThis as { window?: unknown }).window = previousWindow
			if (previousCustomEvent === undefined) {
				delete (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent
			} else {
				;(globalThis as { CustomEvent: typeof CustomEvent }).CustomEvent = previousCustomEvent
			}
		}
	})

	test('reports signer chain id failures without defaulting to mainnet', async () => {
		const previousWindow = (globalThis as { window?: unknown }).window
		const previousCustomEvent = (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent
		const previousConsoleError = console.error
		const {
			fakeWindow,
			signerRequests,
			backgroundSignerChainChanges,
			interceptorErrorPayloads,
		} = createFakeWindow({ signerChainIdReply: new Error('chain id unavailable') })
		const consoleErrors: unknown[] = []
		console.error = (...args: unknown[]) => { consoleErrors.push(args) }
		;(globalThis as unknown as { window: typeof fakeWindow }).window = fakeWindow
		if (typeof (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent !== 'function') {
			;(globalThis as { CustomEvent: typeof CustomEvent }).CustomEvent = class CustomEvent<T = unknown> extends Event {
				public detail: T
				constructor(type: string, init?: CustomEventInit<T>) {
					super(type)
					this.detail = init?.detail as T
				}
				public initCustomEvent(): void { return undefined }
			}
		}

		try {
			await import('../../app/inpage/ts/inpage.js?signer-chain-id-error')
			await waitFor(() => interceptorErrorPayloads.length === 1)

			assert.deepEqual(signerRequests, ['eth_chainId'])
			assert.deepEqual(backgroundSignerChainChanges, [])
			assert.equal(String(interceptorErrorPayloads[0]).includes('inpage: chain id unavailable'), true)
			assert.equal(String(interceptorErrorPayloads[0]).includes('requestMethod: eth_chainId'), true)
			assert.equal(consoleErrors.length > 0, true)
		} finally {
			console.error = previousConsoleError
			;(globalThis as { window?: unknown }).window = previousWindow
			if (previousCustomEvent === undefined) {
				delete (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent
			} else {
				;(globalThis as { CustomEvent: typeof CustomEvent }).CustomEvent = previousCustomEvent
			}
		}
	})

	test('skips readonly compatibility properties without warning', async () => {
		const previousWindow = (globalThis as { window?: unknown }).window
		const previousCustomEvent = (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent
		const previousWarn = console.warn
		let connectedToSigner = false
		const { fakeWindow, sendBackgroundMessage } = createFakeWindow({
			onConnectedToSignerRequest: () => {
				connectedToSigner = true
			},
		})
		const warnings: unknown[] = []
		fakeWindow.ethereum = createLockedCompatibilitySigner()
		console.warn = (...args: unknown[]) => { warnings.push(args) }
		;(globalThis as unknown as { window: typeof fakeWindow }).window = fakeWindow
		if (typeof (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent !== 'function') {
			;(globalThis as { CustomEvent: typeof CustomEvent }).CustomEvent = class CustomEvent<T = unknown> extends Event {
				public detail: T
				constructor(type: string, init?: CustomEventInit<T>) {
					super(type)
					this.detail = init?.detail as T
				}
				public initCustomEvent(): void { return undefined }
			}
		}

		try {
			await import('../../app/inpage/ts/inpage.js?locked-compatibility')
			await waitFor(() => 'isInterceptor' in (fakeWindow.ethereum as Record<string, unknown>))
			assert.equal((fakeWindow.ethereum as { selectedAddress?: unknown }).selectedAddress, undefined)
			assert.deepEqual(warnings, [])
		} finally {
			console.warn = previousWarn
			;(globalThis as { window?: unknown }).window = previousWindow
			if (previousCustomEvent === undefined) {
				delete (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent
			} else {
				;(globalThis as { CustomEvent: typeof CustomEvent }).CustomEvent = previousCustomEvent
			}
		}
	})

	test('does not invoke an accessor-backed window.web3 compatibility shim', async () => {
		let connectedToSigner = false
		let web3GetterCalls = 0
		const { fakeWindow } = createFakeWindow({
			onConnectedToSignerRequest: () => {
				connectedToSigner = true
			},
		})
		Object.defineProperty(fakeWindow, 'web3', {
			configurable: true,
			enumerable: true,
			get: () => {
				web3GetterCalls++
				return { currentProvider: fakeWindow.ethereum }
			},
		})

		await withFakeInpageWindow(fakeWindow, 'accessor-backed-web3-compatibility', async () => {
			await waitFor(() => connectedToSigner)
			assert.equal(web3GetterCalls, 0)
			const descriptor = Object.getOwnPropertyDescriptor(fakeWindow, 'web3')
			assert.equal(descriptor !== undefined && 'value' in descriptor, true)
		})
	})

	test('does not assign through the MetaMask window.web3 proxy shim', async () => {
		let connectedToSigner = false
		let web3ShimAssignments = 0
		const { fakeWindow } = createFakeWindow({
			onConnectedToSignerRequest: () => {
				connectedToSigner = true
			},
		})
		const web3ShimTarget = { currentProvider: fakeWindow.ethereum }
		Object.defineProperty(web3ShimTarget, '__isMetaMaskShim__', {
			configurable: false,
			enumerable: true,
			value: true,
			writable: false,
		})
		const web3Shim = new Proxy(web3ShimTarget, {
			set: (target, property, value) => {
				web3ShimAssignments++
				return Reflect.set(target, property, value)
			},
		})
		fakeWindow.web3 = web3Shim

		await withFakeInpageWindow(fakeWindow, 'metamask-web3-proxy-compatibility', async () => {
			await waitFor(() => connectedToSigner)
			assert.equal(web3ShimAssignments, 0)
			assert.notEqual(fakeWindow.web3, web3Shim)
			assert.equal(fakeWindow.web3?.currentProvider, fakeWindow.ethereum)
		})
	})

	test('skips non-configurable accessor compatibility arrays without reading descriptor value', async () => {
		let connectedToSigner = false
		const { fakeWindow } = createFakeWindow({
			onConnectedToSignerRequest: () => {
				connectedToSigner = true
			},
		})
		const web3 = { currentProvider: fakeWindow.ethereum }
		Object.defineProperty(web3, 'accounts', {
			configurable: false,
			enumerable: true,
			get: () => [],
		})
		Object.defineProperty(fakeWindow, 'web3', {
			configurable: false,
			enumerable: true,
			value: web3,
			writable: false,
		})

		await withFakeInpageWindow(fakeWindow, 'non-configurable-accessor-empty-array-compatibility', async () => {
			await waitFor(() => connectedToSigner)
			assert.equal('isInterceptor' in (fakeWindow.ethereum as Record<string, unknown>), true)
			assert.deepEqual(web3.accounts, [])
			assert.equal('isInterceptor' in (web3.currentProvider as Record<string, unknown>), true)
		})
	})

	test('updates configurable getter-only compatibility properties without throwing', async () => {
		const previousWindow = (globalThis as { window?: unknown }).window
		const previousCustomEvent = (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent
		const previousWarn = console.warn
		let connectedToSigner = false
		const { fakeWindow, sendBackgroundMessage } = createFakeWindow({
			onConnectedToSignerRequest: () => {
				connectedToSigner = true
			},
		})
		const warnings: unknown[] = []
		fakeWindow.ethereum = createConfigurableGetterOnlyCompatibilitySigner()
		console.warn = (...args: unknown[]) => { warnings.push(args) }
		;(globalThis as unknown as { window: typeof fakeWindow }).window = fakeWindow
		if (typeof (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent !== 'function') {
			;(globalThis as { CustomEvent: typeof CustomEvent }).CustomEvent = class CustomEvent<T = unknown> extends Event {
				public detail: T
				constructor(type: string, init?: CustomEventInit<T>) {
					super(type)
					this.detail = init?.detail as T
				}
				public initCustomEvent(): void { return undefined }
			}
		}

		try {
			await import('../../app/inpage/ts/inpage.js?configurable-getter-compatibility')
			await waitFor(() => connectedToSigner)
			sendBackgroundMessage({
				interceptorApproved: true,
				type: 'result',
				method: 'accountsChanged',
				result: ['0x1111111111111111111111111111111111111111'],
			})
			await waitFor(() => (fakeWindow.ethereum as { selectedAddress?: unknown }).selectedAddress === '0x1111111111111111111111111111111111111111')
			assert.deepEqual((fakeWindow.ethereum as { selectedAddress?: unknown }).selectedAddress, '0x1111111111111111111111111111111111111111')
			assert.deepEqual(warnings, [])
		} finally {
			console.warn = previousWarn
			;(globalThis as { window?: unknown }).window = previousWindow
			if (previousCustomEvent === undefined) {
				delete (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent
			} else {
				;(globalThis as { CustomEvent: typeof CustomEvent }).CustomEvent = previousCustomEvent
			}
		}
	})

	test('keeps controlled compatibility properties working after target becomes non-extensible', async () => {
		const previousWindow = (globalThis as { window?: unknown }).window
		const previousCustomEvent = (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent
		const previousWarn = console.warn
		let fakeWindowWithSigner: { ethereum: { isMetamask?: boolean, [key: string]: unknown } } | undefined
		const { fakeWindow, sendBackgroundMessage, signerRequests } = createFakeWindow({
			onConnectedToSignerRequest: () => {
				if (fakeWindowWithSigner === undefined) return
				fakeWindowWithSigner.ethereum.isMetamask = true
				Object.preventExtensions(fakeWindowWithSigner.ethereum)
			},
		})
		fakeWindowWithSigner = fakeWindow
		const warnings: string[] = []
		console.warn = (...args: unknown[]) => { warnings.push(String(args[0])) }
		;(globalThis as unknown as { window: typeof fakeWindow }).window = fakeWindow
		if (typeof (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent !== 'function') {
			;(globalThis as { CustomEvent: typeof CustomEvent }).CustomEvent = class CustomEvent<T = unknown> extends Event {
				public detail: T
				constructor(type: string, init?: CustomEventInit<T>) {
					super(type)
					this.detail = init?.detail as T
				}
				public initCustomEvent(): void { return undefined }
			}
		}

		try {
			await import('../../app/inpage/ts/inpage.js?non-extensible-compatibility')
			await waitFor(() => signerRequests.includes('eth_chainId'))
			sendBackgroundMessage({
				interceptorApproved: true,
				type: 'result',
				method: 'accountsChanged',
				result: ['0x1111111111111111111111111111111111111111'],
			})
			await waitFor(() => (fakeWindow.ethereum as { selectedAddress?: unknown }).selectedAddress === '0x1111111111111111111111111111111111111111')
			assert.deepEqual(warnings, [])
		} finally {
			console.warn = previousWarn
			;(globalThis as { window?: unknown }).window = previousWindow
			if (previousCustomEvent === undefined) {
				delete (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent
			} else {
				;(globalThis as { CustomEvent: typeof CustomEvent }).CustomEvent = previousCustomEvent
			}
		}
	})
})

