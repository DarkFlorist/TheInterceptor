import * as assert from 'assert'
import { describe, spyOn, test } from 'bun:test'
import { getInvalidRpcParamsReply, getMethodSpecificParseFailureReply } from '../../app/ts/background/rpcParseFailureReply.js'
import { EthereumJsonRpcRequest, findEthereumJsonRpcRequestCodec, WalletRevokePermissions } from '../../app/ts/types/JsonRpc-types.js'
import { JSONEncodeableObject } from '../../app/ts/utils/json.js'
import type { InterceptedRequest } from '../../app/ts/utils/requests.js'

const address = '0x1111111111111111111111111111111111111111'

const createRequest = (method: string, params?: unknown[]): InterceptedRequest => ({
	method,
	params,
	interceptorRequest: true,
	usingInterceptorWithoutSigner: false,
	uniqueRequestIdentifier: { requestId: 1, requestSocket: { tabId: 1, connectionName: 0n } },
})

// These tests read request codecs and their method literals through the typed funtypes API, so the explicit method map behind findEthereumJsonRpcRequestCodec is cross-checked against the codecs themselves.
const supportedRequestCodecs = [WalletRevokePermissions, ...EthereumJsonRpcRequest.alternatives]

type ParseableCodec = { safeParse(value: unknown): unknown }

const isParseableCodec = (value: unknown): value is ParseableCodec => typeof value === 'object' && value !== null && 'safeParse' in value && typeof value.safeParse === 'function'

// Test instrumentation that collects a codec and every codec nested in it through the funtypes reflection members, so their validations can be counted. Lazy codecs store a function that returns the underlying codec.
function collectNestedCodecs(codec: unknown, collected = new Set<ParseableCodec>()) {
	if (!isParseableCodec(codec) || collected.has(codec)) return collected
	collected.add(codec)
	for (const member of ['underlying', 'element', 'value', 'alternatives', 'components', 'intersectees', 'fields']) {
		const memberValue: unknown = Reflect.get(codec, member)
		const child: unknown = member === 'underlying' && typeof memberValue === 'function' ? memberValue() : memberValue
		const children: unknown[] = Array.isArray(child) ? child : member === 'fields' && typeof child === 'object' && child !== null ? Object.values(child) : [child]
		for (const nestedCodec of children) collectNestedCodecs(nestedCodec, collected)
	}
	return collected
}

// Counts how often each codec nested in the request codec, or in the JSON object codec of EIP-712 messages, is validated while the readable message is built. The typed data document codec itself is private to eip721.ts and reached only inside the EIP712Message string parser, so its validations are not counted.
function getReadableMessageWithParseCounts(method: string, params: unknown[]) {
	const request = createRequest(method, params)
	const requestCodec = findEthereumJsonRpcRequestCodec(method)
	if (requestCodec === undefined) throw new Error(`Unsupported method ${ method }`)
	const parseResult = requestCodec.safeParse(request)
	if (parseResult.success) throw new Error(`${ method } request should fail to parse`)
	const parseSpies = [...collectNestedCodecs(JSONEncodeableObject, collectNestedCodecs(requestCodec))].map((codec) => spyOn(codec, 'safeParse'))
	try {
		const reply = getInvalidRpcParamsReply(request, requestCodec, parseResult)
		if (reply.type !== 'result' || !('error' in reply)) throw new Error(`Expected an error reply for ${ method }`)
		return { message: reply.error.message, parseCounts: parseSpies.map((parseSpy) => parseSpy.mock.calls.length) }
	} finally {
		for (const parseSpy of parseSpies) parseSpy.mockRestore()
	}
}

const sumParseCounts = (parseCounts: readonly number[]) => parseCounts.reduce((total, count) => total + count, 0)

// EIP-712 typed data whose message nests `depth` objects in each other through their `next` field, ending in a JSON null that EIP-712 messages do not accept.
const createNestedTypedData = (depth: number) => `{"types":{"EIP712Domain":[]},"primaryType":"EIP712Domain","domain":{},"message":${ '{"next":'.repeat(depth) }null${ '}'.repeat(depth) }}`

const getMethodNames = (requestCodec: typeof supportedRequestCodecs[number]) => {
	const methodCodec = requestCodec.fields.method
	return methodCodec.tag === 'literal' ? [methodCodec.value] : methodCodec.alternatives.map((alternative) => alternative.value)
}

const getSupportedRequestCodec = (method: string) => method === 'wallet_revokePermissions' ? WalletRevokePermissions : findEthereumJsonRpcRequestCodec(method)

// Mirrors the background parse failure order: method-specific replies first, then the readable reply built from the method codec failure.
function getParseFailureReply(request: InterceptedRequest) {
	const methodSpecificReply = getMethodSpecificParseFailureReply(request)
	if (methodSpecificReply !== undefined) return methodSpecificReply
	const requestCodec = getSupportedRequestCodec(request.method)
	if (requestCodec === undefined) throw new Error(`Unsupported method ${ request.method }`)
	const parseResult = requestCodec.safeParse(request)
	if (parseResult.success) throw new Error(`${ request.method } request should fail to parse`)
	return getInvalidRpcParamsReply(request, requestCodec, parseResult)
}

function getInvalidParamsError(method: string, params?: unknown[]) {
	const reply = getParseFailureReply(createRequest(method, params))
	if (reply.type !== 'result' || !('error' in reply)) throw new Error(`Expected an error reply for ${ method }`)
	assert.equal(reply.method, method)
	assert.equal(reply.error.code, -32602)
	return reply.error.message
}

describe('readable RPC parse failure replies', () => {
	test('reports a wrong number of parameters with the expected parameter list', () => {
		assert.equal(
			getInvalidParamsError('eth_getBalance', [address, 'latest', '0x1']),
			'eth_getBalance expects 2 parameters (address, block tag), but received 3.',
		)
	})

	test('names the first missing required parameter', () => {
		assert.equal(
			getInvalidParamsError('eth_getBalance', [address]),
			'eth_getBalance is missing required parameter 2 (block tag): expected 2 parameters (address, block tag), but received 1.',
		)
		assert.equal(
			getInvalidParamsError('eth_call', []),
			'eth_call is missing required parameter 1 (transaction object): expected 1 or 2 parameters (transaction object, optional block tag), but received 0.',
		)
		assert.equal(getInvalidParamsError('eth_getBalance', [address, undefined]), 'eth_getBalance is missing required parameter 2 (block tag).')
	})

	test('reports params that are not provided as an array', () => {
		assert.equal(
			getInvalidParamsError('eth_call'),
			'eth_call expects params to be an array of 1 or 2 parameters (transaction object, optional block tag), but no params were provided.',
		)
	})

	test('identifies the parameter and field with the wrong format', () => {
		assert.equal(
			getInvalidParamsError('eth_getBlockByNumber', ['newest', false]),
			'Invalid eth_getBlockByNumber parameter 1 (block tag): expected a block number, block hash or block tag ("latest", "pending", "safe", "finalized" or "earliest"), but received "newest".',
		)
		assert.equal(
			getInvalidParamsError('eth_sendTransaction', [{ to: '0x1234', value: '0x1' }]),
			'Invalid eth_sendTransaction parameter 1 (transaction object) field "to": expected a 20-byte hex address, but received "0x1234".',
		)
		assert.equal(
			getInvalidParamsError('eth_sendTransaction', [{ to: address, value: 100 }]),
			'Invalid eth_sendTransaction parameter 1 (transaction object) field "value": expected a hex quantity, but received 100.',
		)
		assert.equal(
			getInvalidParamsError('eth_sendTransaction', [{ to: address, accessList: [{ address: '0x1', storageKeys: [] }] }]),
			'Invalid eth_sendTransaction parameter 1 (transaction object) field "accessList[0].address": expected a 20-byte hex address, but received "0x1".',
		)
		assert.equal(
			getInvalidParamsError('wallet_switchEthereumChain', [{ chainId: 1 }]),
			'Invalid wallet_switchEthereumChain parameter 1 field "chainId": expected a hex quantity, but received 1.',
		)
	})

	test('names missing required fields of object parameters', () => {
		assert.equal(getInvalidParamsError('wallet_switchEthereumChain', [{}]), 'Invalid wallet_switchEthereumChain parameter 1: missing required field "chainId".')
	})

	test('explains malformed message signing requests', () => {
		assert.equal(
			getInvalidParamsError('personal_sign', ['0xdeadbeef', '0x1234']),
			'Invalid personal_sign parameter 2 (address): expected a 20-byte hex address, but received "0x1234".',
		)
		assert.equal(
			getInvalidParamsError('eth_signTypedData_v4', [address, { types: {}, primaryType: 'Mail' }]),
			'Invalid eth_signTypedData_v4 parameter 2 (typed data): expected EIP-712 typed data encoded as a JSON string, but received an object.',
		)
	})

	test('explains JSON strings that are not EIP-712 typed data', () => {
		const typedDataWithoutDomain = JSON.stringify({ types: { EIP712Domain: [] }, primaryType: 'EIP712Domain', message: {} })
		assert.equal(
			getInvalidParamsError('eth_signTypedData_v4', [address, typedDataWithoutDomain]),
			'Invalid eth_signTypedData_v4 parameter 2 (typed data): the JSON string is not valid EIP-712 typed data (missing required field "domain"); EIP-712 typed data must be a JSON object with types, primaryType, domain and message.',
		)
		assert.equal(
			getInvalidParamsError('eth_signTypedData_v4', [address, '{"types":']),
			'Invalid eth_signTypedData_v4 parameter 2 (typed data): the string is not valid JSON; EIP-712 typed data must be a JSON object with types, primaryType, domain and message.',
		)
	})

	test('does not report present record keys containing a dot as missing', () => {
		const typedDataWithDottedMessageKey = JSON.stringify({ types: { EIP712Domain: [] }, primaryType: 'EIP712Domain', domain: {}, message: { 'a.b': null } })
		const typedDataWithDottedTypeName = JSON.stringify({ types: { EIP712Domain: [], 'A.B': 'notarray' }, primaryType: 'EIP712Domain', domain: {}, message: {} })
		for (const typedData of [typedDataWithDottedMessageKey, typedDataWithDottedTypeName]) {
			const message = getInvalidParamsError('eth_signTypedData_v4', [address, typedData])
			assert.ok(message.startsWith('Invalid eth_signTypedData_v4 parameter 2 (typed data): the JSON string is not valid EIP-712 typed data'), message)
			assert.ok(!message.includes('missing required field'), message)
		}
	})

	test('does not blame a valid record key that prefixes a failing dotted key', () => {
		const messageWithPrefixSibling = JSON.stringify({ types: { EIP712Domain: [] }, primaryType: 'EIP712Domain', domain: {}, message: { a: { b: 'x' }, 'a.b': null } })
		const typesWithPrefixSibling = JSON.stringify({ types: { EIP712Domain: [], A: [], 'A.B': 'notarray' }, primaryType: 'EIP712Domain', domain: {}, message: {} })
		const messageError = getInvalidParamsError('eth_signTypedData_v4', [address, messageWithPrefixSibling])
		assert.ok(!messageError.includes('field "message.a"'), messageError)
		assert.ok(messageError.includes('null'), messageError)
		const typesError = getInvalidParamsError('eth_signTypedData_v4', [address, typesWithPrefixSibling])
		assert.ok(!typesError.includes('field "types.A"'), typesError)
		assert.ok(typesError.includes('notarray'), typesError)
	})

	test('does not blame a valid dotted record key when the shorter key it extends is the failing one', () => {
		const typesWithValidDottedSibling = JSON.stringify({ types: { EIP712Domain: [], A: [{ name: true, type: 't' }], 'A.[0]': [{ name: 'n', type: 't' }] }, primaryType: 'EIP712Domain', domain: {}, message: {} })
		const typesError = getInvalidParamsError('eth_signTypedData_v4', [address, typesWithValidDottedSibling])
		assert.ok(typesError.includes('field "types.A[0].name" must be a string, but received true'), typesError)
	})

	test('validates each nested codec at most once while explaining a deeply nested failure', () => {
		const calls = Array.from({ length: 20 }, (_, index) => ({ from: address, to: index === 19 ? '0x1234' : address, data: '0xabcd' }))
		const { message, parseCounts } = getReadableMessageWithParseCounts('eth_simulateV1', [{ blockStateCalls: [{ calls }] }, 'latest'])
		assert.equal(message, 'Invalid eth_simulateV1 parameter 1 field "blockStateCalls[0].calls[19].to": expected a 20-byte hex address, but received "0x1234".')
		assert.ok(Math.max(...parseCounts) <= 1, `a nested codec was validated ${ Math.max(...parseCounts) } times`)
	})

	test('follows the failure key without validating the enclosing values again', () => {
		const { message, parseCounts } = getReadableMessageWithParseCounts('eth_sendTransaction', [{ from: address, to: '0x1234', data: `0x${ 'ab'.repeat(1000) }` }])
		assert.equal(message, 'Invalid eth_sendTransaction parameter 1 (transaction object) field "to": expected a 20-byte hex address, but received "0x1234".')
		// Only the 20-byte address check of the failing `to` value runs.
		assert.equal(sumParseCounts(parseCounts), 1)
	})

	test('explains a value nested in recursive typed data with one validation per nesting level', () => {
		const { message, parseCounts } = getReadableMessageWithParseCounts('eth_signTypedData_v4', [address, createNestedTypedData(3)])
		assert.equal(
			message,
			'Invalid eth_signTypedData_v4 parameter 2 (typed data): the JSON string is not valid EIP-712 typed data (field "message.next.next.next" must be a string, a boolean, a number, an array or an object, but received null); EIP-712 typed data must be a JSON object with types, primaryType, domain and message.',
		)
		// Besides the uncounted validation of the whole document, only the record holding each further `next` object is validated, once.
		assert.equal(sumParseCounts(parseCounts), 2)
	})

	test('bounds the validations spent explaining deeply nested typed data and falls back to the method codec failure', () => {
		const shallowlyNested = getReadableMessageWithParseCounts('eth_signTypedData_v4', [address, createNestedTypedData(100)])
		const deeplyNested = getReadableMessageWithParseCounts('eth_signTypedData_v4', [address, createNestedTypedData(400)])
		// Without the budget every nesting level validates the remaining levels again, so the validations would grow with the depth.
		assert.equal(sumParseCounts(deeplyNested.parseCounts), sumParseCounts(shallowlyNested.parseCounts))
		for (const { message } of [shallowlyNested, deeplyNested]) {
			assert.ok(message.startsWith('Invalid eth_signTypedData_v4 parameters at params.[1]: '), message)
		}
	})

	test('falls back to the method codec failure when every field is valid on its own', () => {
		assert.equal(
			getInvalidParamsError('eth_sendTransaction', [{ gasPrice: '0x1', maxFeePerGas: '0x1' }]),
			'Invalid eth_sendTransaction parameter 1 (transaction object): {gasPrice: "0x1", maxFeePerGas: "0x1"} failed constraint check.',
		)
		assert.equal(
			getInvalidParamsError('wallet_revokePermissions', [{ eth_accounts: {}, unexpected: true }]),
			'Invalid wallet_revokePermissions parameter 1: Unexpected property: unexpected.',
		)
	})

	test('does not echo long parameter values', () => {
		const longValue = `0x${ 'ab'.repeat(500) }`
		const message = getInvalidParamsError('eth_getBalance', [longValue, 'latest'])
		assert.equal(message, 'Invalid eth_getBalance parameter 1 (address): expected a 20-byte hex address, but received a 1002-character string.')
	})

	test('keeps the existing wallet_watchAsset and wallet_getCapabilities messages', () => {
		assert.equal(getInvalidParamsError('wallet_watchAsset', [{ type: 'ERC721', options: { address } }]), 'Invalid wallet_watchAsset parameters.')
		assert.equal(getInvalidParamsError('wallet_getCapabilities', ['0x1234']), 'Invalid wallet_getCapabilities parameters.')
	})

	test('leaves unsupported methods to the caller', () => {
		assert.equal(getMethodSpecificParseFailureReply(createRequest('eth_unsupportedMethod', [1])), undefined)
		assert.equal(findEthereumJsonRpcRequestCodec('eth_unsupportedMethod'), undefined)
		// Inherited object keys are not methods.
		for (const inheritedKey of ['toString', 'constructor', '__proto__']) assert.equal(findEthereumJsonRpcRequestCodec(inheritedKey), undefined, inheritedKey)
	})

	test('finds the request union member for every supported method', () => {
		for (const requestCodec of EthereumJsonRpcRequest.alternatives) {
			for (const method of getMethodNames(requestCodec)) {
				assert.strictEqual(findEthereumJsonRpcRequestCodec(method), requestCodec, method)
			}
		}
		assert.equal(findEthereumJsonRpcRequestCodec('wallet_revokePermissions'), undefined)
	})

	test('parses valid requests with the method codec exactly like the request union', () => {
		for (const request of [
			createRequest('eth_getBalance', [address, 'latest']),
			createRequest('eth_sendTransaction', [{ from: address, to: address, value: '0x1', maxFeePerGas: '0x2' }]),
			createRequest('eth_signTypedData_v4', [address, JSON.stringify({ types: { EIP712Domain: [] }, primaryType: 'EIP712Domain', domain: {}, message: {} })]),
			createRequest('eth_blockNumber'),
		]) {
			const methodCodecResult = findEthereumJsonRpcRequestCodec(request.method)?.safeParse(request)
			assert.equal(methodCodecResult?.success, true, request.method)
			assert.deepEqual(methodCodecResult, EthereumJsonRpcRequest.safeParse(request), request.method)
		}
	})

	test('replies with invalid params naming the method for every supported method with params', () => {
		const tooManyParams = Array.from({ length: 8 }, (_, index) => `0x${ index }`)
		for (const method of supportedRequestCodecs.flatMap(getMethodNames)) {
			if (getSupportedRequestCodec(method)?.safeParse(createRequest(method, tooManyParams)).success) continue
			assert.ok(getInvalidParamsError(method, tooManyParams).includes(method), method)
		}
	})
})
