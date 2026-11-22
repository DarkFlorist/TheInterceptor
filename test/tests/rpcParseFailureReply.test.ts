import * as assert from 'node:assert'
import { test, spyOn } from 'bun:test'
import { getInvalidRpcParamsReply, getMethodSpecificParseFailureReply } from '../../app/ts/background/rpcParseFailureReply.js'
import { EthereumJsonRpcRequest, findEthereumJsonRpcRequestCodec } from '../../app/ts/types/JsonRpc-types.js'
import type { InterceptedRequest } from '../../app/ts/utils/requests.js'

const createRequest = (method: string, params?: unknown[]): InterceptedRequest => ({
	method,
	params,
	interceptorRequest: true,
	usingInterceptorWithoutSigner: false,
	uniqueRequestIdentifier: { requestId: 1, requestSocket: { tabId: 1, connectionName: 0n } },
})

test('returns the existing method failure without validating the request again', () => {
	const request = createRequest('eth_getBalance', ['0x1234', 'latest'])
	const codec = findEthereumJsonRpcRequestCodec(request.method)
	if (codec === undefined) throw new Error('Missing balance codec')
	const failure = codec.safeParse(request)
	if (failure.success) throw new Error('Expected malformed address to fail')
	const parseSpy = spyOn(codec, 'safeParse')
	try {
		assert.deepEqual(getInvalidRpcParamsReply(request, failure), {
			type: 'result', method: request.method,
			error: { code: -32602, message: `Invalid eth_getBalance parameters: ${ failure.message.replace(/\.$/, '') }.` },
		})
		assert.equal(parseSpy.mock.calls.length, 0)
	} finally { parseSpy.mockRestore() }
})

test('bounds the echoed failure and identifies the method', () => {
	const reply = getInvalidRpcParamsReply(createRequest('eth_call'), { success: false, message: 'x'.repeat(1000) })
	assert.deepEqual(reply, { type: 'result', method: 'eth_call', error: { code: -32602, message: `Invalid eth_call parameters: ${ 'x'.repeat(200) }...` } })
})

test('dispatch map selects the original union member for every method', () => {
	for (const codec of EthereumJsonRpcRequest.alternatives) {
		const method = codec.fields.method
		const names = method.tag === 'literal' ? [method.value] : method.alternatives.map((item) => item.value)
		for (const name of names) assert.strictEqual(findEthereumJsonRpcRequestCodec(name), codec)
	}
	for (const name of ['toString', 'constructor', '__proto__', 'eth_unknown']) assert.equal(findEthereumJsonRpcRequestCodec(name), undefined)
})

test('keeps existing method-specific errors', () => {
	for (const method of ['wallet_watchAsset', 'wallet_getCapabilities']) {
		assert.deepEqual(getMethodSpecificParseFailureReply(createRequest(method, [1])), {
			type: 'result', method, error: { code: -32602, message: `Invalid ${ method } parameters.` },
		})
	}
	assert.equal(getMethodSpecificParseFailureReply(createRequest('eth_unknown')), undefined)
})
