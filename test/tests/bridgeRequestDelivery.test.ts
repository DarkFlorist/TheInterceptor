import { describe, expect, test } from 'bun:test'
import { acknowledgeAndTrackBridgeRequest, isHandledBridgeRequestId } from '../../app/ts/background/bridgeRequestDelivery.js'

describe('bridge request delivery', () => {
	test('acknowledges each delivery and handles ordered request IDs only once', () => {
		const latestReceivedRequestIds = new Map<string, number>()
		const acknowledgements: number[] = []
		const acknowledge = (requestId: number) => () => acknowledgements.push(requestId)

		expect(acknowledgeAndTrackBridgeRequest(latestReceivedRequestIds, 'socket', 1, acknowledge(1))).toBeTrue()
		expect(acknowledgeAndTrackBridgeRequest(latestReceivedRequestIds, 'socket', 1, acknowledge(1))).toBeFalse()
		expect(acknowledgeAndTrackBridgeRequest(latestReceivedRequestIds, 'socket', 2, acknowledge(2))).toBeTrue()

		expect(acknowledgements).toEqual([1, 1, 2])
		expect(latestReceivedRequestIds.get('socket')).toBe(2)
	})

	test('leaves a request eligible for retry when acknowledgement fails', () => {
		const latestReceivedRequestIds = new Map<string, number>()
		const acknowledgementError = new Error('port disconnected')

		expect(() => acknowledgeAndTrackBridgeRequest(latestReceivedRequestIds, 'socket', 1, () => {
			throw acknowledgementError
		})).toThrow(acknowledgementError)
		expect(latestReceivedRequestIds.has('socket')).toBeFalse()
		expect(acknowledgeAndTrackBridgeRequest(latestReceivedRequestIds, 'socket', 1, () => undefined)).toBeTrue()
	})

	test('handles only ordered request IDs and the diagnostics request ID -1', () => {
		expect(isHandledBridgeRequestId(0, 'eth_sendTransaction')).toBeTrue()
		expect(isHandledBridgeRequestId(7, 'eth_sendTransaction')).toBeTrue()
		expect(isHandledBridgeRequestId(-1, 'InterceptorError')).toBeTrue()
		expect(isHandledBridgeRequestId(-1, 'eth_sendTransaction')).toBeFalse()
		expect(isHandledBridgeRequestId(-2, 'InterceptorError')).toBeFalse()
		expect(isHandledBridgeRequestId(Number.NaN, 'eth_sendTransaction')).toBeFalse()
		expect(isHandledBridgeRequestId(Number.POSITIVE_INFINITY, 'eth_sendTransaction')).toBeFalse()
		expect(isHandledBridgeRequestId(1.5, 'eth_sendTransaction')).toBeFalse()
	})

	test('acknowledges a malformed request ID without recording it, so a later ordered request is handled', () => {
		for (const malformedRequestId of [1.5, 2 ** 53, Number.POSITIVE_INFINITY, Number.NaN]) {
			const latestReceivedRequestIds = new Map<string, number>()
			let acknowledgementCount = 0
			acknowledgeAndTrackBridgeRequest(latestReceivedRequestIds, 'socket', malformedRequestId, () => acknowledgementCount++)
			expect(acknowledgementCount).toBe(1)
			expect(latestReceivedRequestIds.has('socket')).toBeFalse()
			expect(acknowledgeAndTrackBridgeRequest(latestReceivedRequestIds, 'socket', 1, () => acknowledgementCount++)).toBeTrue()
			expect(isHandledBridgeRequestId(1, 'eth_sendTransaction')).toBeTrue()
		}
	})

	test('does not deduplicate diagnostic request ID -1', () => {
		const latestReceivedRequestIds = new Map<string, number>()
		let acknowledgementCount = 0

		expect(acknowledgeAndTrackBridgeRequest(latestReceivedRequestIds, 'socket', -1, () => acknowledgementCount++)).toBeTrue()
		expect(acknowledgeAndTrackBridgeRequest(latestReceivedRequestIds, 'socket', -1, () => acknowledgementCount++)).toBeTrue()

		expect(acknowledgementCount).toBe(2)
		expect(latestReceivedRequestIds.has('socket')).toBeFalse()
	})
})
