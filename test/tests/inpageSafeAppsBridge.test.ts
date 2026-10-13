import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { getSafeAppsRequestCommand } from '../../app/ts/background/safeAppsRequestPolicy.js'
import type { RpcNetwork } from '../../app/ts/types/rpc.js'
import { waitFor } from '../harness/async.js'
import { createFakeWindow, type InpageRequest, isSafeAppsEnvelopeCandidate, isSafeAppsReply, type PageEvent, type SafeAppsReply, type SendBackgroundMessage, waitOneEventLoopTurn, withFakeInpageWindow } from './inpageSignerBridgeHarness.js'
import { readProperty } from '../harness/assertions.js'

function sendSafeAppsCompatibility(sendBackgroundMessage: SendBackgroundMessage, enabled: boolean) {
	sendBackgroundMessage({ interceptorApproved: true, type: 'result', method: 'safe_apps_compatibility', result: { enabled } })
}

function getSafeAppsMethod(request: InpageRequest) {
	const safeRequest = request.params?.[0]
	return isSafeAppsEnvelopeCandidate(safeRequest) && typeof safeRequest.method === 'string' ? safeRequest.method : undefined
}

function replyToSafeAppsRequest(request: InpageRequest, sendBackgroundMessage: SendBackgroundMessage, result: unknown) {
	sendBackgroundMessage({ interceptorApproved: true, requestId: request.requestId, type: 'result', method: 'safe_apps_request', result })
}

function rejectSafeAppsRequest(request: InpageRequest, sendBackgroundMessage: SendBackgroundMessage, message: string) {
	sendBackgroundMessage({ interceptorApproved: true, requestId: request.requestId, type: 'result', method: 'safe_apps_request', error: { code: -32602, message } })
}

describe('inpage Safe Apps bridge', () => {
	test('rejects unsafe or malformed Safe Apps messages before forwarding Ethereum requests', async () => {
		const ethereumRequests: InpageRequest[] = []
		let connected = false
		const { fakeWindow } = createFakeWindow({
			handleRequest: (request, sendBackgroundMessage) => {
				if (request.method === 'connected_to_signer') {
					connected = true
					sendBackgroundMessage({
						interceptorApproved: true,
						requestId: request.requestId,
						type: 'result',
						method: request.method,
						result: { metamaskCompatibilityMode: false },
					})
					sendSafeAppsCompatibility(sendBackgroundMessage, true)
					return true
				}
				if (request.method === 'safe_apps_request') {
					const safeAppsMethod = getSafeAppsMethod(request)
					rejectSafeAppsRequest(request, sendBackgroundMessage, safeAppsMethod === 'rpcCall' ? 'Unsupported Safe Apps RPC call.' : `Unsupported Safe Apps method: ${ safeAppsMethod }.`)
					return true
				}
				if (request.internal !== true) ethereumRequests.push(request)
				return false
			},
		})

		await withFakeInpageWindow(fakeWindow, 'safe-apps-message-boundary', async () => {
			await waitFor(() => connected)
			await waitOneEventLoopTurn()
			const replies: SafeAppsReply[] = []
			fakeWindow.addEventListener('message', (event) => {
				if (isSafeAppsReply(event.data)) replies.push(event.data)
			})
			const validRequest = { id: 'unsafe-safe-info', method: 'getSafeInfo', env: { sdkVersion: '9.1.0' } }
			fakeWindow.dispatchEvent({ type: 'message', data: validRequest, origin: 'https://untrusted.example', source: fakeWindow })
			fakeWindow.dispatchEvent({ type: 'message', data: validRequest, origin: fakeWindow.location.origin, source: {} })
			fakeWindow.postMessage({ id: 'missing-env', method: 'getSafeInfo' }, fakeWindow.location.origin)
			fakeWindow.postMessage({ id: 'invalid-env', method: 'getSafeInfo', env: { sdkVersion: 9 } }, fakeWindow.location.origin)
			fakeWindow.postMessage({ id: 'empty-version', method: 'getSafeInfo', env: { sdkVersion: '' } }, fakeWindow.location.origin)
			fakeWindow.postMessage({ id: 'invalid-version', method: 'getSafeInfo', env: { sdkVersion: 'not-a-version' } }, fakeWindow.location.origin)
			fakeWindow.postMessage({ id: 'unsupported-version', method: 'getSafeInfo', env: { sdkVersion: '0.9.0' } }, fakeWindow.location.origin)
			fakeWindow.postMessage({ id: 'missing-method', env: { sdkVersion: '9.1.0' } }, fakeWindow.location.origin)
			fakeWindow.postMessage({ id: 'invalid-method', method: 1, env: { sdkVersion: '9.1.0' } }, fakeWindow.location.origin)
			fakeWindow.postMessage({ id: 'invalid-method-and-env', method: 1, env: {} }, fakeWindow.location.origin)
			fakeWindow.postMessage({ id: 'unknown-method', method: 'notSafeApps', env: { sdkVersion: '9.1.0' } }, fakeWindow.location.origin)
			fakeWindow.postMessage({ id: 'invalid-rpc-params', method: 'rpcCall', params: {}, env: { sdkVersion: '9.1.0' } }, fakeWindow.location.origin)
			await waitFor(() => replies.length === 9)
			assert.deepEqual(replies.sort((left, right) => String(left.id).localeCompare(String(right.id))), [
				{ id: 'empty-version', success: false, error: 'Safe Apps env.sdkVersion must be a supported semantic version.', version: '9.1.0' },
				{ id: 'invalid-env', success: false, error: 'Safe Apps env.sdkVersion must be a supported semantic version.', version: '9.1.0' },
				{ id: 'invalid-method', success: false, error: 'Safe Apps method must be a string.', version: '9.1.0' },
				{ id: 'invalid-method-and-env', success: false, error: 'Safe Apps env.sdkVersion must be a supported semantic version.', version: '9.1.0' },
				{ id: 'invalid-rpc-params', success: false, error: 'Unsupported Safe Apps RPC call.', version: '9.1.0' },
				{ id: 'invalid-version', success: false, error: 'Safe Apps env.sdkVersion must be a supported semantic version.', version: '9.1.0' },
				{ id: 'missing-method', success: false, error: 'Safe Apps method must be a string.', version: '9.1.0' },
				{ id: 'unknown-method', success: false, error: 'Unsupported Safe Apps method: notSafeApps.', version: '9.1.0' },
				{ id: 'unsupported-version', success: false, error: 'Safe Apps env.sdkVersion must be a supported semantic version.', version: '9.1.0' },
			])
			assert.deepEqual(ethereumRequests, [])
		})
	})

	test('queues an early Safe Apps request until the enabled setting arrives', async () => {
		const account = '0x1111111111111111111111111111111111111111'
		const ethereumRequests: InpageRequest[] = []
		let replyToConnection: (() => void) | undefined
		const { fakeWindow } = createFakeWindow({
			handleRequest: (request, sendBackgroundMessage) => {
				if (request.method === 'connected_to_signer') {
					replyToConnection = () => {
						sendBackgroundMessage({ interceptorApproved: true, requestId: request.requestId, type: 'result', method: request.method, result: { metamaskCompatibilityMode: false } })
						sendSafeAppsCompatibility(sendBackgroundMessage, true)
					}
					return true
				}
				if (request.method === 'safe_apps_request') {
					replyToSafeAppsRequest(request, sendBackgroundMessage, { kind: 'result', value: { safeAddress: account } })
					return true
				}
				if (request.internal === true) return false
				ethereumRequests.push(request)
				const result = request.method === 'eth_requestAccounts' || request.method === 'eth_accounts' ? [account] : request.method === 'eth_chainId' ? '0x1' : '0x'
				sendBackgroundMessage({ interceptorApproved: true, requestId: request.requestId, type: 'result', method: request.method, result })
				return true
			},
		})

		await withFakeInpageWindow(fakeWindow, 'safe-apps-early-request', async () => {
			const replies: SafeAppsReply[] = []
			const response = new Promise<SafeAppsReply>((resolve) => {
				fakeWindow.addEventListener('message', (event) => {
					if (!isSafeAppsReply(event.data)) return
					replies.push(event.data)
					if (event.data.id === 'early-safe-info') resolve(event.data)
				})
			})
			for (let index = 0; index < 40; index += 1) {
				fakeWindow.postMessage({ id: `generic-early-${ index }`, method: 'unrelatedProtocolMethod' }, fakeWindow.location.origin)
			}
			fakeWindow.postMessage({ id: 'early-safe-info', method: 'getSafeInfo', env: { sdkVersion: '9.1.0' } }, fakeWindow.location.origin)
			await waitOneEventLoopTurn()
			assert.deepEqual(ethereumRequests, [])
			assert.notEqual(replyToConnection, undefined)
			replyToConnection?.()
			const safeInfoReply = await response
			assert.equal(safeInfoReply.success, true)
			assert.equal(readProperty(safeInfoReply.data, 'safeAddress'), account)
			for (let index = 0; index < 40; index += 1) {
				fakeWindow.postMessage({ id: `generic-enabled-${ index }`, method: 'unrelatedProtocolMethod' }, fakeWindow.location.origin)
			}
			fakeWindow.postMessage({ id: 'enabled-safe-info', method: 'getSafeInfo', env: { sdkVersion: '9.1.0' } }, fakeWindow.location.origin)
			await waitFor(() => replies.length === 2)
			assert.deepEqual(replies.map((reply) => reply.id), ['early-safe-info', 'enabled-safe-info'])
		})
	})

	test('completes direct-app discovery after initial ineligibility without replaying transactions', async () => {
		let publishCompatibility: ((enabled: boolean) => void) | undefined
		const forwardedMethods: (string | undefined)[] = []
		const { fakeWindow } = createFakeWindow({
			handleRequest: (request, sendBackgroundMessage) => {
				if (request.method === 'connected_to_signer') {
					publishCompatibility = (enabled) => sendSafeAppsCompatibility(sendBackgroundMessage, enabled)
					sendBackgroundMessage({ interceptorApproved: true, requestId: request.requestId, type: 'result', method: request.method, result: { metamaskCompatibilityMode: false } })
					return true
				}
				if (request.method !== 'safe_apps_request') return false
				forwardedMethods.push(getSafeAppsMethod(request))
				replyToSafeAppsRequest(request, sendBackgroundMessage, { kind: 'result', value: { chainId: 1 } })
				return true
			},
		})
		await withFakeInpageWindow(fakeWindow, 'safe-apps-delayed-eligibility', async () => {
			const replies: SafeAppsReply[] = []
			fakeWindow.addEventListener('message', (event) => {
				if (!isSafeAppsReply(event.data)) return
				replies.push(event.data)
				// The test app waits for Safe info before requesting chain info.
				if (event.data.id === 'startup-info') fakeWindow.postMessage({ id: 'startup-chain', method: 'getChainInfo', env: { sdkVersion: '9.1.0' } }, fakeWindow.location.origin)
			})
			await waitFor(() => publishCompatibility !== undefined)
			fakeWindow.postMessage({ id: 'startup-info', method: 'getSafeInfo', env: { sdkVersion: '9.1.0' } }, fakeWindow.location.origin)
			fakeWindow.postMessage({ id: 'early-transaction', method: 'sendTransactions', env: { sdkVersion: '9.1.0' } }, fakeWindow.location.origin)
			await waitOneEventLoopTurn()
			publishCompatibility?.(false)
			await waitOneEventLoopTurn()
			fakeWindow.postMessage({ id: 'later-info', method: 'getSafeInfo', env: { sdkVersion: '9.1.0' } }, fakeWindow.location.origin)
			fakeWindow.postMessage({ id: 'disabled-transaction', method: 'sendTransactions', env: { sdkVersion: '9.1.0' } }, fakeWindow.location.origin)
			await waitOneEventLoopTurn()
			assert.deepEqual(forwardedMethods, [])
			assert.deepEqual(replies, [])
			publishCompatibility?.(false)
			publishCompatibility?.(true)
			await waitFor(() => replies.length === 3)
			assert.deepEqual(replies.map((reply) => reply.id).sort(), ['later-info', 'startup-chain', 'startup-info'])
			assert.equal(replies.every((reply) => reply.success === true), true)
			assert.deepEqual(forwardedMethods, ['getSafeInfo', 'getSafeInfo', 'getChainInfo'])
		})
	})

	for (const settleWhileDisabled of [false, true]) {
		test(`retries in-flight startup discovery after eligibility changes, settling ${ settleWhileDisabled ? 'before' : 'after' } re-enablement`, async () => {
			let publishCompatibility: ((enabled: boolean) => void) | undefined
			let settleOldRequest: (() => void) | undefined
			let forwarded = 0
			const { fakeWindow } = createFakeWindow({ handleRequest: (request, sendBackgroundMessage) => {
				if (request.method === 'connected_to_signer') {
					publishCompatibility = (enabled) => sendSafeAppsCompatibility(sendBackgroundMessage, enabled)
					sendBackgroundMessage({ interceptorApproved: true, requestId: request.requestId, type: 'result', method: request.method, result: { metamaskCompatibilityMode: false } })
					publishCompatibility(true)
					return true
				}
				if (request.method !== 'safe_apps_request') return false
				forwarded += 1
				if (forwarded === 1) settleOldRequest = () => replyToSafeAppsRequest(request, sendBackgroundMessage, { kind: 'result', value: { safeAddress: 'old-safe' } })
				else replyToSafeAppsRequest(request, sendBackgroundMessage, { kind: 'result', value: { safeAddress: 'current-safe' } })
				return true
			} })
			await withFakeInpageWindow(fakeWindow, `safe-apps-inflight-discovery-${ settleWhileDisabled }`, async () => {
				const replies: SafeAppsReply[] = []
				fakeWindow.addEventListener('message', (event) => {
					if (isSafeAppsReply(event.data)) replies.push(event.data)
				})
				await waitFor(() => publishCompatibility !== undefined)
				fakeWindow.postMessage({ id: 'refresh-discovery', method: 'getSafeInfo', env: { sdkVersion: '9.1.0' } }, fakeWindow.location.origin)
				await waitFor(() => settleOldRequest !== undefined)
				publishCompatibility?.(false)
				await waitOneEventLoopTurn()
				if (!settleWhileDisabled) publishCompatibility?.(true)
				settleOldRequest?.()
				await waitOneEventLoopTurn()
				if (settleWhileDisabled) {
					assert.deepEqual(replies, [])
					assert.equal(forwarded, 1)
					publishCompatibility?.(true)
				}
				await waitFor(() => replies.length === 1)
				assert.equal(replies[0]?.id, 'refresh-discovery')
				assert.deepEqual(replies[0]?.data, { safeAddress: 'current-safe' })
				assert.equal(forwarded, 2)
			})
		})
	}

	for (const rejected of [false, true]) {
		test(`requests ordinary account access once for Safe discovery and ${ rejected ? 'returns rejection' : 'resumes discovery' }`, async () => {
			let accessRequests = 0
			const { fakeWindow } = createFakeWindow({ handleRequest: (request, sendBackgroundMessage) => {
				if (request.method === 'connected_to_signer') {
					sendBackgroundMessage({ interceptorApproved: true, requestId: request.requestId, type: 'result', method: request.method, result: { metamaskCompatibilityMode: false } })
					sendBackgroundMessage({ interceptorApproved: true, type: 'result', method: 'safe_apps_compatibility', result: { enabled: false, canRequestAccess: true } })
					return true
				}
				if (request.method === 'eth_accounts') {
					sendBackgroundMessage({ interceptorApproved: true, requestId: request.requestId, type: 'result', method: request.method, result: [] })
					return true
				}
				if (request.method === 'eth_requestAccounts') {
					accessRequests += 1
					if (rejected) sendBackgroundMessage({ interceptorApproved: true, requestId: request.requestId, type: 'result', method: request.method, error: { code: 4001, message: 'Connection rejected.' } })
					else {
						sendSafeAppsCompatibility(sendBackgroundMessage, true)
						sendBackgroundMessage({ interceptorApproved: true, requestId: request.requestId, type: 'result', method: request.method, result: ['0x1111111111111111111111111111111111111111'] })
					}
					return true
				}
				if (request.method !== 'safe_apps_request') return false
				replyToSafeAppsRequest(request, sendBackgroundMessage, { kind: 'result', value: { chainId: 1 } })
				return true
			} })
			await withFakeInpageWindow(fakeWindow, `safe-connect-${ rejected }`, async () => {
				const replies: SafeAppsReply[] = []
				fakeWindow.addEventListener('message', (event) => {
					if (isSafeAppsReply(event.data)) replies.push(event.data)
				})
				for (const id of ['first-discovery', 'second-discovery']) fakeWindow.postMessage({ id, method: 'getSafeInfo', env: { sdkVersion: '9.1.0' } }, fakeWindow.location.origin)
				await waitFor(() => replies.length === 2)
				assert.equal(accessRequests, 1)
				assert.equal(replies.every((reply) => reply.success === !rejected), true)
				if (rejected) {
					fakeWindow.postMessage({ id: 'after-rejection', method: 'getSafeInfo', env: { sdkVersion: '9.1.0' } }, fakeWindow.location.origin)
					await waitFor(() => replies.length === 3)
					assert.equal(replies.every((reply) => reply.error === 'Connection rejected.'), true)
					assert.equal(accessRequests, 1)
				}
			})
		})
	}

	test('bounds early discovery and ignores signing until Safe Apps is enabled', async () => {
		let replyToConnection: (() => void) | undefined
		const { fakeWindow } = createFakeWindow({
			handleRequest: (request, sendBackgroundMessage) => {
				if (request.method === 'connected_to_signer') {
					replyToConnection = () => {
						sendBackgroundMessage({ interceptorApproved: true, requestId: request.requestId, type: 'result', method: request.method, result: { metamaskCompatibilityMode: false } })
						sendSafeAppsCompatibility(sendBackgroundMessage, true)
					}
					return true
				}
				if (request.method !== 'safe_apps_request') return false
				rejectSafeAppsRequest(request, sendBackgroundMessage, 'Discovery fixture response.')
				return true
			},
		})

		await withFakeInpageWindow(fakeWindow, 'safe-apps-bounded-early-requests', async () => {
			const replies: SafeAppsReply[] = []
			fakeWindow.addEventListener('message', (event) => {
				if (isSafeAppsReply(event.data)) replies.push(event.data)
			})
			fakeWindow.postMessage({ id: 'early-signing', method: 'signMessage', params: { message: 'Do not queue this' }, env: { sdkVersion: '9.1.0' } }, fakeWindow.location.origin)
			for (let index = 0; index < 40; index += 1) {
				fakeWindow.postMessage({ id: `early-${ index }`, method: 'getSafeInfo', env: { sdkVersion: '9.1.0' } }, fakeWindow.location.origin)
			}
			await waitOneEventLoopTurn()
			assert.deepEqual(replies, [])
			replyToConnection?.()
			await waitFor(() => replies.length === 32)
			assert.equal(replies.filter((reply) => reply.error === 'Discovery fixture response.').length, 32)
			assert.equal(replies.filter((reply) => reply.error === 'Interceptor Safe Apps request queue is full. Retry after the connection finishes initializing.').length, 0)
			await waitOneEventLoopTurn()
			assert.equal(replies.length, 32)
		})
	})

	test('settles overflow discovery requests while account approval is pending', async () => {
		let rejectAccess: (() => void) | undefined
		const { fakeWindow } = createFakeWindow({ handleRequest: (request, sendBackgroundMessage) => {
			if (request.method === 'connected_to_signer') {
				sendBackgroundMessage({ interceptorApproved: true, requestId: request.requestId, type: 'result', method: request.method, result: { metamaskCompatibilityMode: false } })
				sendBackgroundMessage({ interceptorApproved: true, type: 'result', method: 'safe_apps_compatibility', result: { enabled: false, canRequestAccess: true } })
				return true
			}
			if (request.method !== 'eth_requestAccounts') return false
			rejectAccess = () => sendBackgroundMessage({ interceptorApproved: true, requestId: request.requestId, type: 'result', method: request.method, error: { code: 4001, message: 'Connection rejected.' } })
			return true
		} })
		await withFakeInpageWindow(fakeWindow, 'safe-connecting-overflow', async () => {
			const replies: SafeAppsReply[] = []
			fakeWindow.addEventListener('message', (event) => {
				if (isSafeAppsReply(event.data)) replies.push(event.data)
			})
			for (let index = 0; index < 40; index += 1) {
				fakeWindow.postMessage({ id: `discovery-${ index }`, method: 'getSafeInfo', env: { sdkVersion: '9.1.0' } }, fakeWindow.location.origin)
				if (index === 0) await waitFor(() => rejectAccess !== undefined)
			}
			await waitFor(() => replies.length === 8 && rejectAccess !== undefined)
			rejectAccess?.()
			await waitFor(() => replies.length === 40)
			assert.equal(new Set(replies.map((reply) => reply.id)).size, 40)
			assert.equal(replies.filter((reply) => reply.error === 'Connection rejected.').length, 32)
			assert.equal(replies.filter((reply) => reply.error === 'Interceptor Safe Apps request queue is full. Retry after the connection finishes initializing.').length, 8)
		})
	})

	test('drops an in-flight Safe Apps response when website approval is revoked', async () => {
		let pendingRpcRequest: InpageRequest | undefined
		const { fakeWindow, sendBackgroundMessage } = createFakeWindow({
			handleRequest: (request, sendBackgroundMessageForRequest) => {
				if (request.method === 'connected_to_signer') {
					sendBackgroundMessageForRequest({
						interceptorApproved: true,
						requestId: request.requestId,
						type: 'result',
						method: request.method,
						result: { metamaskCompatibilityMode: false },
					})
					sendSafeAppsCompatibility(sendBackgroundMessageForRequest, true)
					return true
				}
				if (request.method === 'safe_apps_request') {
					replyToSafeAppsRequest(request, sendBackgroundMessageForRequest, { kind: 'ethereumRequest', method: 'eth_call', params: [], mapResult: 'passthrough' })
					return true
				}
				if (request.method === 'eth_call' && request.internal !== true) {
					pendingRpcRequest = request
					return true
				}
				return false
			},
		})

		await withFakeInpageWindow(fakeWindow, 'safe-apps-revoked-in-flight', async () => {
			let responseCount = 0
			fakeWindow.addEventListener('message', (event) => {
				if (isSafeAppsReply(event.data) && event.data.id === 'revoked-rpc') responseCount += 1
			})
			await waitOneEventLoopTurn()
			fakeWindow.postMessage({ id: 'revoked-rpc', method: 'rpcCall', params: { call: 'eth_call', params: [] }, env: { sdkVersion: '9.1.0' } }, fakeWindow.location.origin)
			await waitFor(() => pendingRpcRequest !== undefined)
			sendBackgroundMessage({
				interceptorApproved: true,
				type: 'result',
				method: 'safe_apps_compatibility',
				result: { enabled: false },
			})
			await waitOneEventLoopTurn()
			const rpcRequest = pendingRpcRequest
			if (rpcRequest === undefined) throw new Error('Missing deferred Safe RPC request')
			sendBackgroundMessage({ interceptorApproved: true, requestId: rpcRequest.requestId, type: 'result', method: rpcRequest.method, result: '0x1234' })
			await waitOneEventLoopTurn()
			assert.equal(responseCount, 0)
		})
	})

	test('answers Safe Apps protocol requests only when experimental compatibility is enabled', async () => {
		const disabledEthereumRequests: InpageRequest[] = []
		const disabledHarness = createFakeWindow({
			handleRequest: (request) => {
				if (request.internal !== true) disabledEthereumRequests.push(request)
				return false
			},
		})
		await withFakeInpageWindow(disabledHarness.fakeWindow, 'safe-apps-protocol-disabled', async () => {
			let responseCount = 0
			disabledHarness.fakeWindow.addEventListener('message', (event) => {
				if (isSafeAppsReply(event.data)) responseCount += 1
			})
			disabledHarness.fakeWindow.postMessage({ id: 'disabled-safe-info', method: 'getSafeInfo', env: { sdkVersion: '9.1.0' } }, disabledHarness.fakeWindow.location.origin)
			await waitOneEventLoopTurn()
			assert.equal(responseCount, 0)
			assert.deepEqual(disabledEthereumRequests, [])
		})

		const account = '0x1111111111111111111111111111111111111111'
		const safeState = { version: '1.4.1', nonce: 7n, owners: [0x3333333333333333333333333333333333333333n, 0x4444444444444444444444444444444444444444n], threshold: 2n }
		const ethereumRequests: InpageRequest[] = []
		let connected = false
		let rpcNetwork: RpcNetwork = { name: 'Polygon', chainId: 137n, httpsRpc: 'https://polygon.example', currencyName: 'POL', currencyTicker: 'POL', currencyLogoUri: 'https://example.com/pol.svg', blockExplorer: { apiUrl: 'https://api.polygonscan.com/api', apiKey: '' }, primary: false, minimized: false }
		const { fakeWindow, sendBackgroundMessage } = createFakeWindow({
			handleRequest: (request, sendBackgroundMessage) => {
				if (request.method === 'connected_to_signer') {
					connected = true
					sendBackgroundMessage({
						interceptorApproved: true,
						requestId: request.requestId,
						type: 'result',
						method: request.method,
						result: { metamaskCompatibilityMode: false },
					})
					sendSafeAppsCompatibility(sendBackgroundMessage, true)
					return true
				}
				if (request.method === 'safe_apps_request') {
					const envelope = request.params?.[0]
					if (isSafeAppsEnvelopeCandidate(envelope) && envelope.method === 'execute') {
						ethereumRequests.push(request)
						sendBackgroundMessage({ interceptorApproved: true, requestId: request.requestId, type: 'result', method: request.method, result: '0xsafehash' })
						return true
					}
					void getSafeAppsRequestCommand(request.params?.[0], fakeWindow.location.origin, BigInt(account), rpcNetwork, async () => safeState).then(
						(command) => replyToSafeAppsRequest(request, sendBackgroundMessage, command),
						(error: unknown) => rejectSafeAppsRequest(request, sendBackgroundMessage, error instanceof Error ? error.message : 'Safe Apps request failed.'),
					)
					return true
				}
				if (request.internal === true) return false
				ethereumRequests.push(request)
				const result = request.method === 'eth_requestAccounts' || request.method === 'eth_accounts'
					? [account]
					: request.method === 'eth_getLogs'
							? ['log-entry']
						: request.method === 'eth_getBlockByNumber'
								? { number: '0x123' }
							: request.method === 'eth_sendTransaction'
								? '0xsafehash'
								: '0x'
				sendBackgroundMessage({ interceptorApproved: true, requestId: request.requestId, type: 'result', method: request.method, result })
				return true
			},
		})

		await withFakeInpageWindow(fakeWindow, 'safe-apps-protocol', async () => {
			await waitFor(() => connected)
			await waitOneEventLoopTurn()
			const safeRequest = (method: string, params?: unknown) => new Promise<SafeAppsReply>((resolve) => {
				const id = `${ method }-${ Math.random().toString(16) }`
				const listener = (event: PageEvent) => {
					if (!isSafeAppsReply(event.data) || event.data.id !== id) return
					fakeWindow.removeEventListener('message', listener)
					resolve(event.data)
				}
				fakeWindow.addEventListener('message', listener)
				fakeWindow.postMessage({ id, method, env: { sdkVersion: '9.1.0' }, ...(params === undefined ? {} : { params }) }, fakeWindow.location.origin)
			})

			const safeInfoReply = await safeRequest('getSafeInfo')
			assert.equal(safeInfoReply.success, true)
			assert.deepEqual(safeInfoReply.data, {
				safeAddress: account,
				chainId: 137,
				owners: ['0x3333333333333333333333333333333333333333', '0x4444444444444444444444444444444444444444'],
				threshold: 2,
				isReadOnly: false,
				nonce: 7,
				implementation: '0x0000000000000000000000000000000000000000',
				modules: [],
				fallbackHandler: '0x0000000000000000000000000000000000000000',
				guard: '0x0000000000000000000000000000000000000000',
				version: '1.4.1',
				network: 'CHAIN_137',
			})
			const chainInfoReply = await safeRequest('getChainInfo')
			assert.deepEqual(chainInfoReply.data, {
				chainName: 'Polygon',
				chainId: '137',
				shortName: 'Polygon',
				nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18, logoUri: 'https://example.com/pol.svg' },
				blockExplorerUriTemplate: { address: '', txHash: '', api: 'https://api.polygonscan.com/api' },
			})
			rpcNetwork = { name: 'Optimism', chainId: 10n, httpsRpc: 'https://optimism.example', currencyName: 'Ether', currencyTicker: 'ETH', primary: false, minimized: false }
			await waitOneEventLoopTurn()
			const updatedChainInfoReply = await safeRequest('getChainInfo')
			assert.deepEqual(updatedChainInfoReply.data, {
				chainName: 'Optimism',
				chainId: '10',
				shortName: 'Optimism',
				nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18, logoUri: '' },
				blockExplorerUriTemplate: { address: '', txHash: '', api: '' },
			})

			const rpcReply = await safeRequest('rpcCall', { call: 'eth_getPastLogs', params: [{ fromBlock: 'latest' }] })
			assert.deepEqual(rpcReply.data, ['log-entry'])
			const blockReply = await safeRequest('rpcCall', { call: 'eth_getBlockByNumber', params: ['latest'] })
			assert.deepEqual(blockReply.data, { number: '0x123' })
			const getPermissionsReply = await safeRequest('wallet_getPermissions')
			assert.deepEqual(getPermissionsReply.data, [])
			const aliasedGetPermissionsReply = await safeRequest('rpcCall', { call: 'eth_getPermissions', params: [] })
			assert.deepEqual(aliasedGetPermissionsReply.data, [])
			const permissionParams = [{ requestAddressBook: {} }]
			const requestPermissionsReply = await safeRequest('wallet_requestPermissions', permissionParams)
			assert.equal(requestPermissionsReply.success, false)
			assert.equal(requestPermissionsReply.error, 'Interceptor Safe compatibility does not support the requestAddressBook permission.')
			const aliasedRequestPermissionsReply = await safeRequest('rpcCall', { call: 'eth_requestPermissions', params: permissionParams })
			assert.equal(aliasedRequestPermissionsReply.success, false)
			assert.equal(aliasedRequestPermissionsReply.error, 'Interceptor Safe compatibility does not support the requestAddressBook permission.')
			const invalidPermissionReply = await safeRequest('wallet_requestPermissions', {})
			assert.equal(invalidPermissionReply.success, false)
			assert.equal(invalidPermissionReply.error, 'Safe Apps permission request params must be an array.')
			const emptyPermissionReply = await safeRequest('wallet_requestPermissions', [])
			assert.deepEqual(emptyPermissionReply.data, [])
			const unsupportedPermissionReply = await safeRequest('wallet_requestPermissions', [{ eth_accounts: {} }])
			assert.equal(unsupportedPermissionReply.success, false)
			assert.equal(unsupportedPermissionReply.error, 'Unsupported Safe Apps permission request.')
			const transaction = { to: '0x2222222222222222222222222222222222222222', value: '15', data: '0x1234' }
			const sendReply = await safeRequest('sendTransactions', { txs: [transaction], params: { safeTxGas: 21000 } })
			assert.deepEqual(sendReply.data, { safeTxHash: '0xsafehash' })
			const zeroGasSendReply = await safeRequest('sendTransactions', { txs: [transaction], params: { safeTxGas: 0 } })
			assert.deepEqual(zeroGasSendReply.data, { safeTxHash: '0xsafehash' })
			const delegateCallReply = await safeRequest('sendTransactions', { txs: [{ ...transaction, operation: 1 }] })
			assert.equal(delegateCallReply.success, false)
			assert.equal(delegateCallReply.error, 'Safe Apps delegate calls are not supported inside a batch or as app-provided transactions.')
			const batchReply = await safeRequest('sendTransactions', { txs: [transaction, transaction], params: undefined })
			assert.equal(batchReply.success, true)
			assert.deepEqual(batchReply.data, { safeTxHash: '0xsafehash' })
			const batchRequest = ethereumRequests.pop()
			const batchEnvelope = batchRequest?.params?.[0]
			if (!isSafeAppsEnvelopeCandidate(batchEnvelope) || !isSafeAppsEnvelopeCandidate(batchEnvelope.params) || !Array.isArray(batchEnvelope.params.params)) throw new Error('Missing Safe execution envelope')
			const batchTransaction: unknown = batchEnvelope.params.params[0]
			if (typeof batchTransaction !== 'object' || batchTransaction === null) throw new Error('Missing batch transaction')
			assert.equal('safeOperation' in batchTransaction, false)
			assert.equal(batchRequest?.method, 'safe_apps_request')
			const envelope = batchRequest?.params?.[0]
			assert.ok(isSafeAppsEnvelopeCandidate(envelope) && isSafeAppsEnvelopeCandidate(envelope.params))
			assert.deepEqual(envelope.params.safeRequestContext, { operation: 1 })
			assert.equal(readProperty(batchTransaction, 'to'), '0x9641d764fc13c8b624c04430c7356c1c7c8102e2')
			assert.deepEqual(ethereumRequests.map(({ method, params }) => ({ method, params })), [
				{ method: 'eth_getLogs', params: [{ fromBlock: 'latest' }] },
				{ method: 'eth_getBlockByNumber', params: ['latest', false] },
				{ method: 'eth_sendTransaction', params: [{ from: account, to: transaction.to, value: '0xf', data: transaction.data, gas: '0x5208' }] },
				{ method: 'eth_sendTransaction', params: [{ from: account, to: transaction.to, value: '0xf', data: transaction.data }] },
			])

			let responseCountAfterDisable = 0
			fakeWindow.addEventListener('message', (event) => {
				if (isSafeAppsReply(event.data) && event.data.id === 'disabled-after-update') responseCountAfterDisable += 1
			})
			sendBackgroundMessage({
				interceptorApproved: true,
				type: 'result',
				method: 'safe_apps_compatibility',
				result: { enabled: false },
			})
			await waitOneEventLoopTurn()
			fakeWindow.postMessage({ id: 'disabled-after-update', method: 'getSafeInfo', env: { sdkVersion: '9.1.0' } }, fakeWindow.location.origin)
			await waitOneEventLoopTurn()
			assert.equal(responseCountAfterDisable, 0)
		})
	})

	test('Safe Apps message signing submits only a successful owner signature and returns the SDK message hash', async () => {
		for (const rejected of [false, true]) for (const isTypedData of [false, true]) {
			const method = isTypedData ? 'signTypedMessage' : 'signMessage'
			const typedMetadata = isTypedData ? { isTypedData: true } : {}
			const signature = `0x${ '12'.repeat(65) }`
			const messageHash = `0x${ '34'.repeat(32) }`
			const safeAddress = '0x1111111111111111111111111111111111111111'
			let submissions = 0
			const { fakeWindow } = createFakeWindow({
				handleRequest: (request, reply) => {
					if (request.method === 'connected_to_signer') {
						reply({ interceptorApproved: true, requestId: request.requestId, type: 'result', method: request.method, result: { metamaskCompatibilityMode: false } })
						sendSafeAppsCompatibility(reply, true)
						return true
					}
					if (getSafeAppsMethod(request) === method) {
						replyToSafeAppsRequest(request, reply, { kind: 'ethereumRequest', method: 'eth_signTypedData_v4', params: [safeAddress, '{}'], mapResult: 'safeMessage', message: 'Hello Safe', ...typedMetadata, safeAddress, chainId: '1' })
						return true
					}
					if (request.method === 'eth_signTypedData_v4') {
						reply({ interceptorApproved: true, requestId: request.requestId, type: 'result', method: request.method, ...(rejected ? { error: { code: 4001, message: 'User rejected signing.' } } : { result: signature }) })
						return true
					}
					if (getSafeAppsMethod(request) === 'submitOffChainMessage') {
						submissions++
						assert.deepEqual(request.params?.[0], { method: 'submitOffChainMessage', params: { message: 'Hello Safe', signature, ...typedMetadata, safeAddress, chainId: '1' } })
						replyToSafeAppsRequest(request, reply, { kind: 'result', value: { messageHash } })
						return true
					}
					return false
				},
			})
			await withFakeInpageWindow(fakeWindow, `safe-message-${ rejected }-${ isTypedData }`, async () => {
				let response: unknown
				fakeWindow.addEventListener('message', (event) => {
					if (isSafeAppsReply(event.data) && event.data.id === 'sign-message') response = event.data
				})
				await waitOneEventLoopTurn()
				fakeWindow.postMessage({ id: 'sign-message', method, params: { message: 'Hello Safe' }, env: { sdkVersion: '9.0.0' } }, fakeWindow.location.origin)
				await waitFor(() => response !== undefined)
				if (!isSafeAppsReply(response)) throw new Error('Missing Safe Apps response')
				assert.equal(response.success, !rejected)
				assert.equal(submissions, rejected ? 0 : 1)
				if (rejected) assert.equal(response.error, 'User rejected signing.')
				else assert.deepEqual(response.data, { messageHash })
			})
		}
	})

	test('Safe SDK settings belong to the page and survive background connection reinitialization for both signing methods', async () => {
		const network: RpcNetwork = { name: 'Ethereum', chainId: 1n, httpsRpc: 'https://example.test', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }
		const safe = 0x1111111111111111111111111111111111111111n
		let handshakes = 0
		let proposalCount = 0
		const { fakeWindow, sendBackgroundMessage } = createFakeWindow({ handleRequest: (request, reply) => {
			if (request.method === 'connected_to_signer') {
				handshakes++
				reply({ interceptorApproved: true, requestId: request.requestId, type: 'result', method: request.method, result: { metamaskCompatibilityMode: false } })
				sendSafeAppsCompatibility(reply, true)
				return true
			}
			if (request.method === 'safe_apps_request') {
				const envelope = request.params?.[0]
				if (isSafeAppsEnvelopeCandidate(envelope) && envelope.method === 'execute') {
					proposalCount++
					reply({ interceptorApproved: true, requestId: request.requestId, type: 'result', method: request.method, result: '0x' + 'ab'.repeat(32) })
					return true
				}
				// Each invocation uses fresh background policy state, just as after an MV3 worker restart.
				void getSafeAppsRequestCommand(request.params?.[0], 'example.test', safe, network, async () => { throw new Error('Unexpected Safe state lookup') }).then((command) => {
					if (command.kind === 'ethereumRequest') {
						assert.equal(command.method, 'eth_sendTransaction')
						assert.equal(command.mapResult, 'safeTxHash')
						const proposedTransaction = command.params[0]
						assert.ok(typeof proposedTransaction === 'object' && proposedTransaction !== null)
						assert.equal(command.safeRequestContext?.operation, 1)
						assert.equal(readProperty(proposedTransaction, 'to'), '0xd53cd0ab83d845ac265be939c57f53ad838012c9')
					}
					replyToSafeAppsRequest(request, reply, command.kind === 'settings' ? { kind: 'result', value: { offChainSigning: command.offChainSigning } } : command)
				}, (error) => rejectSafeAppsRequest(request, reply, String(error)))
				return true
			}
			if (request.method === 'eth_sendTransaction') {
				proposalCount++
				reply({ interceptorApproved: true, requestId: request.requestId, type: 'result', method: request.method, result: '0x' + 'ab'.repeat(32) })
				return true
			}
			return false
		} })
		await withFakeInpageWindow(fakeWindow, 'safe-settings-reconnect', async () => {
			await waitFor(() => handshakes === 1)
			const replies = new Map<string, unknown>()
			fakeWindow.addEventListener('message', ({ data }) => {
				if (isSafeAppsReply(data) && typeof data.id === 'string') replies.set(data.id, data)
			})
			fakeWindow.postMessage({ id: 'settings', method: 'rpcCall', params: { call: 'safe_setSettings', params: [{ offChainSigning: false }] }, env: { sdkVersion: '9.0.0' } }, fakeWindow.location.origin)
			await waitFor(() => replies.has('settings'))
			assert.deepEqual(replies.get('settings'), { id: 'settings', success: true, data: { offChainSigning: false }, version: '9.1.0' })
			sendSafeAppsCompatibility(sendBackgroundMessage, false)
			sendBackgroundMessage({ interceptorApproved: true, type: 'result', method: 'request_signer_connection_status', result: [] })
			await waitFor(() => handshakes === 2)
			for (const method of ['signMessage', 'signTypedMessage']) {
				const params = method === 'signMessage' ? { message: 'On-chain only' } : { typedData: { domain: {}, types: { Note: [{ name: 'text', type: 'string' }] }, message: { text: 'On-chain typed' } } }
				fakeWindow.postMessage({ id: method, method, params, env: { sdkVersion: '9.0.0' } }, fakeWindow.location.origin)
				await waitFor(() => replies.has(method))
				assert.deepEqual(replies.get(method), { id: method, success: true, data: { safeTxHash: '0x' + 'ab'.repeat(32) }, version: '9.1.0' })
			}
			assert.equal(proposalCount, 2)
		})
	})
})
