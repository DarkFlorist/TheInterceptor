import { describe, expect, test } from 'bun:test'
import { acknowledgeAndTrackBridgeRequest } from '../../app/ts/background/bridgeRequestDelivery.js'
import { classifyRequestId, INTERCEPTOR_DIAGNOSTIC_REQUEST } from '../../app/ts/utils/requests.js'

const pageRequest = (requestId: number) => ({ requestId, method: 'eth_sendTransaction' })

describe('bridge request delivery', () => {
	test('acknowledges every delivery and distinguishes a new ordered request from its replay', () => {
		const watermark = new Map<string, number>()
		const acknowledged: number[] = []
		const deliver = (requestId: number) => acknowledgeAndTrackBridgeRequest(watermark, 'socket', pageRequest(requestId), () => acknowledged.push(requestId))
		expect(deliver(1)).toBe('handle')
		expect(deliver(1)).toBe('duplicate')
		expect(deliver(2)).toBe('handle')
		expect(acknowledged).toEqual([1, 1, 2])
		expect(watermark.get('socket')).toBe(2)
	})

	test('leaves a request eligible for retry when acknowledgement fails', () => {
		const watermark = new Map<string, number>()
		const error = new Error('port disconnected')
		expect(() => acknowledgeAndTrackBridgeRequest(watermark, 'socket', pageRequest(1), () => { throw error })).toThrow(error)
		expect(watermark.has('socket')).toBeFalse()
		expect(acknowledgeAndTrackBridgeRequest(watermark, 'socket', pageRequest(1), () => undefined)).toBe('handle')
	})

	test('request identity owns the ordered and diagnostic categories', () => {
		expect(classifyRequestId(pageRequest(0))).toBe('ordered')
		expect(classifyRequestId(pageRequest(7))).toBe('ordered')
		expect(classifyRequestId(INTERCEPTOR_DIAGNOSTIC_REQUEST)).toBe('diagnostic')
		expect(classifyRequestId(pageRequest(INTERCEPTOR_DIAGNOSTIC_REQUEST.requestId))).toBe('invalid')
		expect(classifyRequestId({ ...INTERCEPTOR_DIAGNOSTIC_REQUEST, requestId: -2 })).toBe('invalid')
	})

	test('invalid identities have an explicit outcome and never poison the watermark or look like a replay', () => {
		for (const requestId of [-2, -1, 1.5, 2 ** 53, Number.POSITIVE_INFINITY, Number.NaN]) {
			const watermark = new Map<string, number>()
			let acknowledgements = 0
			expect(acknowledgeAndTrackBridgeRequest(watermark, 'socket', pageRequest(requestId), () => acknowledgements++)).toBe('invalid')
			expect(acknowledgements).toBe(1)
			expect(watermark.has('socket')).toBeFalse()
			expect(acknowledgeAndTrackBridgeRequest(watermark, 'socket', pageRequest(1), () => undefined)).toBe('handle')
		}
	})

	test('diagnostics are handled repeatedly without advancing an existing ordered watermark', () => {
		const watermark = new Map([['socket', 7]])
		let acknowledgements = 0
		for (let delivery = 0; delivery < 2; delivery++) expect(acknowledgeAndTrackBridgeRequest(watermark, 'socket', INTERCEPTOR_DIAGNOSTIC_REQUEST, () => acknowledgements++)).toBe('handle')
		expect(acknowledgements).toBe(2)
		expect(watermark.get('socket')).toBe(7)
	})
})
