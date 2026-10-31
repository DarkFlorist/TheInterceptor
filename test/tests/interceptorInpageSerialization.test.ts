import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { InterceptorMessageToInpage, serializeInpageReply, serializeInpageCallback } from '../../app/ts/types/interceptor-messages.js'

describe('inpage message serialization', () => {
	test('matches errors without inspecting method-specific success results', () => {
		for (const method of ['eth_getBalance', 'eth_call', 'eth_getLogs', 'eth_requestAccounts', 'wallet_getCapabilities', 'unknown_method']) {
			let successResultReads = 0
			const message = {
				interceptorApproved: true as const,
				type: 'result' as const,
				requestId: 7,
				bridgeRequestSettled: true as const,
				method,
				error: { code: 4100, message: 'Unauthorized', data: 'Permission denied' },
				// A getter detects traversal of the success schemas without relying on machine-dependent timing thresholds.
				get result() { successResultReads += 1; return undefined },
			}
			const wireMessage = serializeInpageReply(message)
			assert.equal(successResultReads, 0, method)
			assert.deepEqual(JSON.parse(JSON.stringify(wireMessage)), {
				interceptorApproved: true,
				type: 'result',
				requestId: 7,
				bridgeRequestSettled: true,
				method,
				error: message.error,
			})
			assert.equal(InterceptorMessageToInpage.safeParse(wireMessage).success, true)
		}
	})

	test('still converts successful quantities and validates their result types', () => {
		const message = { interceptorApproved: true as const, type: 'result' as const, requestId: 8, method: 'eth_getBalance' as const, result: 15n }
		const wireMessage = InterceptorMessageToInpage.serialize(message)
		assert.ok('result' in wireMessage)
		assert.equal(wireMessage.result, '0xf')
		assert.equal(InterceptorMessageToInpage.safeParse(wireMessage).success, true)
		assert.throws(() => InterceptorMessageToInpage.serialize({ ...message, result: -1n }))
	})

	test('rejects malformed errors rather than bypassing error validation', () => {
		const message = { interceptorApproved: true, type: 'result', requestId: 9, method: 'eth_call', error: { code: '4100', message: 'Unauthorized' } }
		assert.equal(InterceptorMessageToInpage.safeParse(message).success, false)
	})

	test('successful replies dispatch by method without traversing unrelated result schemas', () => {
		for (const method of ['eth_blockNumber', 'eth_chainId', 'eth_gasPrice', 'eth_getTransactionCount'] as const) {
			let resultReads = 0
			const message = {
				interceptorApproved: true as const,
				type: 'result' as const,
				requestId: 10,
				bridgeRequestSettled: true as const,
				method,
				get result() { resultReads += 1; return 15n },
			}
			const wireMessage = serializeInpageReply(message)
			assert.equal(resultReads, 1, method)
			assert.ok('result' in wireMessage)
			assert.equal(wireMessage.result, '0xf')
			assert.equal(InterceptorMessageToInpage.safeParse(wireMessage).success, true)
		}
	})

	test('callbacks dispatch by method and retain optional request IDs without adding settlement markers', () => {
		let resultReads = 0
		const message = {
			interceptorApproved: true as const,
			type: 'result' as const,
			method: 'accountsChanged' as const,
			requestId: 11,
			get result() { resultReads += 1; return [1n] },
		}
		const wireMessage = serializeInpageCallback(message)
		assert.equal(resultReads, 1)
		assert.deepEqual(JSON.parse(JSON.stringify(wireMessage)), {
			interceptorApproved: true,
			type: 'result',
			method: 'accountsChanged',
			requestId: 11,
			result: ['0x0000000000000000000000000000000000000001'],
		})
		assert.equal(InterceptorMessageToInpage.safeParse(wireMessage).success, true)
	})

	test('error callbacks use the shared wire contract without reading success results', () => {
		let resultReads = 0
		const message = {
			interceptorApproved: true as const,
			type: 'result' as const,
			method: 'accountsChanged',
			error: { code: 4100, message: 'Unauthorized' },
			get result() { resultReads += 1; return undefined },
		}
		const wireMessage = serializeInpageCallback(message)
		assert.equal(resultReads, 0)
		assert.equal(InterceptorMessageToInpage.safeParse(wireMessage).success, true)
		assert.deepEqual(JSON.parse(JSON.stringify(wireMessage)), {
			interceptorApproved: true,
			type: 'result',
			method: 'accountsChanged',
			error: message.error,
		})
	})
})
