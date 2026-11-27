import * as assert from 'node:assert/strict'
import { test } from 'bun:test'
import { parseNativeGnosisSafeAppsSignerRequest, parseNativeGnosisSafeAppsSignerReplyToken } from '../../app/shared/ts/nativeGnosisSafeAppsSignerProtocol.js'

test('native signer wire requests require correlation, generation and wallet parameters', () => {
	const request = { token: 'private-request', signerProviderGeneration: 4, request: { method: 'personal_sign', params: ['0x1234', '0x1111111111111111111111111111111111111111'] } }
	assert.deepEqual(parseNativeGnosisSafeAppsSignerRequest(request), request)
	for (const value of [undefined, {}, { ...request, token: '' }, { ...request, signerProviderGeneration: -1 }, { ...request, signerProviderGeneration: 1.5 }, { ...request, request: { method: 'personal_sign', params: 'wrong' } }]) assert.equal(parseNativeGnosisSafeAppsSignerRequest(value), undefined)
})

test('native signer replies expose only their opaque correlation token', () => {
	assert.equal(parseNativeGnosisSafeAppsSignerReplyToken({ token: 'private-request', requestId: 123, tabId: 99 }), 'private-request')
	for (const value of [undefined, 'private-request', [], { token: 123 }]) assert.equal(parseNativeGnosisSafeAppsSignerReplyToken(value), undefined)
})
