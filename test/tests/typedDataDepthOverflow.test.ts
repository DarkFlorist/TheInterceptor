import * as assert from 'assert'
import { describe, spyOn, test } from 'bun:test'
import { parseSafeTypedMessage } from '../../app/ts/safe/safeMessage.js'
import { EthereumJsonRpcRequest } from '../../app/ts/types/JsonRpc-types.js'
import { EIP712Message } from '../../app/ts/types/eip721.js'
import { confirmedSignerOwnership, createEthereumWithGetBlockCounter, createPort, installBrowserMock, loadModules, noopPublishRpcConnectionStatus } from './backgroundEthAccountsTestHarness.js'
import { withSilencedConsole } from './consoleSilence.js'

// Far past the deepest limit measured on any engine (about 4600 levels), so these tests do not depend on the stack size.
const NESTING_LEVELS = 100_000
const SIGNER_ADDRESS = '0x5555555555555555555555555555555555555555'
const TYPED_DATA_METHODS = ['eth_signTypedData_v1', 'eth_signTypedData_v2', 'eth_signTypedData_v3', 'eth_signTypedData_v4'] as const
const TYPED_DATA_ENVELOPE = { types: { EIP712Domain: [] }, primaryType: 'EIP712Domain', domain: {} }

const createTypedDataJson = (messageJson: string) => `${ JSON.stringify(TYPED_DATA_ENVELOPE).slice(0, -1) },"message":${ messageJson }}`
const deepTypedDataJson = createTypedDataJson(`${ '{"a":'.repeat(NESTING_LEVELS) }"leaf"${ '}'.repeat(NESTING_LEVELS) }`)
const shallowTypedDataJson = createTypedDataJson('{"a":"leaf"}')

function createDeepTypedDataValue() {
	let message: unknown = 'leaf'
	for (let level = 0; level < NESTING_LEVELS; level++) message = { a: message }
	return { ...TYPED_DATA_ENVELOPE, message }
}

function createSpiderMonkeyError(message: string) {
	return Object.assign(new Error(message), { name: 'InternalError' })
}

// Only the parser's reviver call is replaced, so the plain JSON.parse in isJSON keeps working and the error reaches the parser's own handling.
function withRevivingJsonParse<T>(revive: () => unknown, runWithReviving: () => T) {
	const originalParse = JSON.parse
	const parseSpy = spyOn(JSON, 'parse').mockImplementation((text, reviver) => reviver === undefined ? originalParse(text) : revive())
	try {
		return runWithReviving()
	} finally {
		parseSpy.mockRestore()
	}
}

describe('typed data nested past the call stack limit', () => {
	test.each(TYPED_DATA_METHODS)('the request codec rejects a deep %s document', (method) => {
		const parsed = EthereumJsonRpcRequest.safeParse({ method, params: [SIGNER_ADDRESS, deepTypedDataJson] })
		assert.equal(parsed.success, false)
	})

	test('a document too deep to validate is rejected even when the JSON reviver survives it', () => {
		const deepTypedDataValue = createDeepTypedDataValue()
		const parsed = withRevivingJsonParse(() => deepTypedDataValue, () => EIP712Message.safeParse(shallowTypedDataJson))
		assert.equal(parsed.success, false)
	})

	test('the SpiderMonkey stack overflow error is rejected like the V8 and JavaScriptCore one', () => {
		const parsed = withRevivingJsonParse(() => { throw createSpiderMonkeyError('too much recursion') }, () => EIP712Message.safeParse(shallowTypedDataJson))
		assert.equal(parsed.success, false)
	})

	test.each([
		['TypeError', new TypeError('codec bug')],
		['RangeError that is not a stack overflow', new RangeError('Invalid array length')],
		['InternalError that is not a stack overflow', createSpiderMonkeyError('codec bug')],
	])('a %s from the parser propagates', (_name, programmerError) => {
		assert.throws(() => withRevivingJsonParse(() => { throw programmerError }, () => EIP712Message.safeParse(shallowTypedDataJson)), (error: unknown) => error === programmerError)
	})

	test('the parser keeps working after a stack overflow', () => {
		assert.equal(EIP712Message.safeParse(deepTypedDataJson).success, false)
		assert.equal(EIP712Message.safeParse(shallowTypedDataJson).success, true)
	})

	test('a deep document gets the parse failure reply instead of an unknown error', async () => {
		installBrowserMock()
		const { handleInterceptedRequest, websiteSocketToString, updateWebsiteAccess, changeSimulationMode, setUseSignersAddressAsActiveAddress } = await loadModules()
		const websiteOrigin = 'https://deep-typed-data.example'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const account = 1n
		await setUseSignersAddressAsActiveAddress(false)
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: account })
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }] }])
		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: true,
			uniqueRequestIdentifier: { requestId: 7, requestSocket: socket },
			method: 'eth_signTypedData_v4',
			params: [SIGNER_ADDRESS, deepTypedDataJson],
		}

		await withSilencedConsole(async () => await handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, request, websiteTabConnections, noopPublishRpcConnectionStatus))

		const reply = messages.find((message) => message.requestId === 7)
		assert.equal(reply?.error?.code, -32700)
		assert.ok(reply?.error?.message.startsWith('Failed to parse RPC request: '))
	})

	test('a deep Safe typed message within the 100000 character limit is rejected as invalid', () => {
		const arrayLevels = 49_000
		const deepSafeMessage = createTypedDataJson(`{"a":${ '['.repeat(arrayLevels) }${ ']'.repeat(arrayLevels) }}`)
		assert.ok(deepSafeMessage.length <= 100_000)
		assert.throws(() => parseSafeTypedMessage(deepSafeMessage), { message: 'The Safe typed message is not valid EIP-712 data.' })
	})

	test('a programmer error while parsing a Safe typed message propagates', () => {
		const programmerError = new RangeError('Invalid array length')
		const originalParse = JSON.parse
		// The first JSON.parse is the isJSON check, the second one is the parse that is guarded against stack overflows.
		const parseSpy = spyOn(JSON, 'parse').mockImplementationOnce(originalParse).mockImplementationOnce(() => { throw programmerError })
		try {
			assert.throws(() => parseSafeTypedMessage(shallowTypedDataJson), (error: unknown) => error === programmerError)
		} finally {
			parseSpy.mockRestore()
		}
	})
})
