import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { waitFor } from '../harness/async.js'
import { replaceProperty } from '../harness/globals.js'
import { createFakeWindow, isChainSwitchReplyCandidate, isRpcErrorCandidate, waitOneEventLoopTurn, withFakeInpageWindow } from './inpageSignerBridgeHarness.js'

describe('inpage signer connection, account discovery and chain switching', () => {
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

	test('settles signer account discovery when no signer initializes', async () => {
		const connectedToSignerParams: (readonly unknown[])[] = []
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

	test('reports a fresh signer epoch when the background requests reconnect status', async () => {
		const connectedToSignerParams: (readonly unknown[])[] = []
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
		const connectedToSignerParams: (readonly unknown[])[] = []
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
			await waitOneEventLoopTurn()
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
		if (!isChainSwitchReplyCandidate(reply) || !isRpcErrorCandidate(reply.error)) throw new Error('Malformed chain switch reply')
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
		if (!isChainSwitchReplyCandidate(reply) || !isRpcErrorCandidate(reply.error)) throw new Error('Malformed chain switch reply')
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
		if (!isChainSwitchReplyCandidate(reply) || !isRpcErrorCandidate(reply.error)) throw new Error('Malformed chain switch reply')
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
		assert.deepEqual(replies.map(reply => isChainSwitchReplyCandidate(reply) ? [reply.walletSwitchRequestId, reply.accept] : undefined), [['current', true], ['expired', true]])
	})

	test('reports signer chain id failures without defaulting to mainnet', async () => {
		const {
			fakeWindow,
			signerRequests,
			backgroundSignerChainChanges,
			interceptorErrorPayloads,
		} = createFakeWindow({ signerChainIdReply: new Error('chain id unavailable') })
		const consoleErrors: unknown[] = []
		const restoreConsoleError = replaceProperty(console, 'error', (...args: unknown[]) => { consoleErrors.push(args) })

		try {
			await withFakeInpageWindow(fakeWindow, 'signer-chain-id-error', async () => {
				await waitFor(() => interceptorErrorPayloads.length === 1)

				assert.deepEqual(signerRequests, ['eth_chainId'])
				assert.deepEqual(backgroundSignerChainChanges, [])
				assert.equal(String(interceptorErrorPayloads[0]).includes('inpage: chain id unavailable'), true)
				assert.equal(String(interceptorErrorPayloads[0]).includes('requestMethod: eth_chainId'), true)
				assert.equal(consoleErrors.length > 0, true)
			})
		} finally {
			restoreConsoleError()
		}
	})
})
