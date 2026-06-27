import * as assert from 'assert'
import { describe, test } from 'bun:test'
import type { Abi, AbiEvent, AbiParameter } from 'viem'
import { parseAbiParametersToSolidityVariables } from '../../app/ts/utils/solidityTypes.js'
import { decodeEventLoose } from '../../app/ts/utils/abiRuntime.js'
import { encodeFunctionCall } from '../../app/ts/utils/abiRuntime.js'
import { encodeAbiParameters, formatAbiItem, toEventSelector } from '../../app/ts/utils/viem.js'
import { dataStringWith0xStart } from '../../app/ts/utils/bigint.js'
import { parseInputData } from '../../app/ts/simulation/parsing.js'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import type { IEthereumJSONRpcRequestHandler } from '../../app/ts/simulation/services/EthereumJSONRpcRequestHandler.js'
import { EthereumData } from '../../app/ts/types/wire-types.js'
import type { RpcEntry } from '../../app/ts/types/rpc.js'

const OWNER_ADDRESS = 0x1000000000000000000000000000000000000001n
const TOKEN_ADDRESS = 0x2000000000000000000000000000000000000002n
const INDEXED_TOPIC_HASH = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
const OFFERER_ADDRESS = '0x3000000000000000000000000000000000000003'
const ZONE_ADDRESS = '0x4000000000000000000000000000000000000004'
const RECIPIENT_ADDRESS = '0x5000000000000000000000000000000000000005'
const SEAPORT_TOKEN_ADDRESS = '0x6000000000000000000000000000000000000006'
const CONSIDERATION_RECIPIENT_ADDRESS = '0x7000000000000000000000000000000000000007'
const WEB3J_EVENT_ADDRESS = '0x8000000000000000000000000000000000000008'
const TUPLE_INPUT_CONTRACT_ADDRESS = 0x9000000000000000000000000000000000000009n
const TUPLE_INPUT_CONTRACT_ADDRESS_STRING = '0x9000000000000000000000000000000000000009'
const TEST_RPC_URL = 'https://example.invalid'

const tupleAbiParameters = [
	{
		name: 'order',
		type: 'tuple',
		components: [
			{ name: 'owner', type: 'address' },
			{ name: 'amount', type: 'uint256' },
		],
	},
	{
		name: 'fills',
		type: 'tuple[]',
		components: [
			{ name: 'token', type: 'address' },
			{ name: 'amount', type: 'uint256' },
		],
	},
] satisfies readonly AbiParameter[]

const bytes32LikeBytesAbiParameters = [{
	name: 'payload',
	type: 'bytes',
}] satisfies readonly AbiParameter[]

const tupleWithHashFieldAbiParameters = [{
	name: 'proof',
	type: 'tuple',
	components: [
		{ name: 'hash', type: 'bytes32' },
	],
}] satisfies readonly AbiParameter[]

const tupleInputFunctionAbi = [
	{
		type: 'function',
		name: 'fulfill',
		stateMutability: 'nonpayable',
		inputs: [
			{
				name: 'order',
				type: 'tuple',
				components: [
					{ name: 'owner', type: 'address' },
					{ name: 'amount', type: 'uint256' },
				],
			},
			{
				name: 'fills',
				type: 'tuple[]',
				components: [
					{ name: 'token', type: 'address' },
					{ name: 'amount', type: 'uint256' },
				],
			},
		],
		outputs: [],
	},
] satisfies Abi

const web3jAbiV2ExampleEvent = {
	type: 'event',
	name: 'Event',
	inputs: [
		{ name: '_address', type: 'address', indexed: true },
		{
			name: '_foo',
			type: 'tuple',
			components: [
				{ name: 'id', type: 'string' },
				{ name: 'name', type: 'string' },
			],
		},
		{
			name: '_bar',
			type: 'tuple',
			components: [
				{ name: 'id', type: 'uint256' },
				{ name: 'data', type: 'string' },
			],
		},
	],
} satisfies AbiEvent

const seaportOrderFulfilledEvent = {
	type: 'event',
	name: 'OrderFulfilled',
	inputs: [
		{ name: 'orderHash', type: 'bytes32' },
		{ name: 'offerer', type: 'address' },
		{ name: 'zone', type: 'address' },
		{ name: 'recipient', type: 'address' },
		{
			name: 'offer',
			type: 'tuple[]',
			components: [
				{ name: 'itemType', type: 'uint8' },
				{ name: 'token', type: 'address' },
				{ name: 'identifier', type: 'uint256' },
				{ name: 'amount', type: 'uint256' },
			],
		},
		{
			name: 'consideration',
			type: 'tuple[]',
			components: [
				{ name: 'itemType', type: 'uint8' },
				{ name: 'token', type: 'address' },
				{ name: 'identifier', type: 'uint256' },
				{ name: 'amount', type: 'uint256' },
				{ name: 'recipient', type: 'address' },
			],
		},
	],
} satisfies AbiEvent

const indexedTupleEvent = {
	type: 'event',
	name: 'Order',
	inputs: [{
		name: 'order',
		type: 'tuple',
		indexed: true,
		components: [
			{ name: 'owner', type: 'address' },
			{ name: 'amount', type: 'uint256' },
		],
	}],
} satisfies AbiEvent

const indexedTupleArrayEvent = {
	type: 'event',
	name: 'Orders',
	inputs: [{
		name: 'orders',
		type: 'tuple[]',
		indexed: true,
		components: [
			{ name: 'owner', type: 'address' },
			{ name: 'amount', type: 'uint256' },
		],
	}],
} satisfies AbiEvent

const toIndexedAddressTopic = (address: string) => `0x${ address.slice(2).padStart(64, '0') }`
const toAddressHex = (address: bigint) => `0x${ address.toString(16).padStart(40, '0') }`

const installBrowserStorageMock = (storageState: Record<string, unknown>) => {
	const previousBrowser = globalThis.browser
	Object.defineProperty(globalThis, 'browser', {
		value: {
			storage: {
				local: {
					async get(keys?: string | string[] | Record<string, unknown> | null) {
						if (keys === undefined || keys === null) return { ...storageState }
						if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, storageState[key]]))
						if (typeof keys === 'string') return { [keys]: storageState[keys] }
						return Object.fromEntries(Object.entries(keys).map(([key, defaultValue]) => [key, key in storageState ? storageState[key] : defaultValue]))
					},
					async set(items: Record<string, unknown>) {
						Object.assign(storageState, items)
					},
					async remove(keys: string | string[]) {
						for (const key of Array.isArray(keys) ? keys : [keys]) delete storageState[key]
					},
				},
			},
		},
		configurable: true,
		writable: true,
	})
	return () => {
		Object.defineProperty(globalThis, 'browser', { value: previousBrowser, configurable: true, writable: true })
	}
}

const testRpcEntry = {
	name: 'Ethereum',
	chainId: 1n,
	httpsRpc: TEST_RPC_URL,
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	primary: true,
	minimized: false,
} satisfies RpcEntry

const createTestEthereumClientService = () => {
	const requestHandler = {
		rpcUrl: TEST_RPC_URL,
		clearCache: () => undefined,
		getChainId: async () => 1n,
		jsonRpcRequest: async (rpcRequest: { readonly method: string }) => {
			throw new Error(`Unexpected RPC request during parseInputData test: ${ rpcRequest.method }`)
		},
	} satisfies IEthereumJSONRpcRequestHandler
	return new EthereumClientService(requestHandler, async () => undefined, async () => undefined, testRpcEntry)
}

const encodeEventData = (event: AbiEvent, values: readonly unknown[]) => {
	const unindexedInputs = event.inputs.filter((input) => input.indexed !== true)
	const unindexedValues = values.filter((_value, index) => event.inputs[index]?.indexed !== true)
	return encodeAbiParameters(unindexedInputs, unindexedValues)
}

const parseDecodedEvent = (event: AbiEvent, values: readonly unknown[], indexedTopics: readonly string[]) => {
	const selector = toEventSelector(formatAbiItem(event))
	const decoded = decodeEventLoose([event], { data: encodeEventData(event, values), topics: [selector, ...indexedTopics] })
	if (decoded === undefined) throw new Error('failed to decode event')
	return parseAbiParametersToSolidityVariables(event.inputs, decoded.args)
}

const parseDecodedIndexedEvent = (event: AbiEvent) => {
	const selector = toEventSelector(formatAbiItem(event))
	const decoded = decodeEventLoose([event], { data: '0x', topics: [selector, INDEXED_TOPIC_HASH] })
	if (decoded === undefined) throw new Error('failed to decode indexed tuple event')
	return parseAbiParametersToSolidityVariables(event.inputs, decoded.args)
}

const assertIndexedTupleHash = (event: AbiEvent, paramName: string) => {
	const variables = parseDecodedIndexedEvent(event)
	const variable = variables[0]
	assert.equal(variable?.paramName, paramName)
	assert.equal(variable?.typeValue.type, 'fixedBytes')
	if (variable?.typeValue.type !== 'fixedBytes') throw new Error('expected indexed tuple to parse as fixedBytes')
	assert.equal(dataStringWith0xStart(variable.typeValue.value), INDEXED_TOPIC_HASH)
}

describe('parseAbiParametersToSolidityVariables', () => {
	test('parses tuple and tuple array ABI parameters recursively', () => {
		const variables = parseAbiParametersToSolidityVariables(tupleAbiParameters, [
			{
				owner: '0x1000000000000000000000000000000000000001',
				amount: 5n,
			},
			[
				['0x2000000000000000000000000000000000000002', 7n],
			],
		])

		assert.deepEqual(variables, [
			{
				paramName: 'order',
				typeValue: {
					type: 'tuple',
					value: [
						{ paramName: 'owner', typeValue: { type: 'address', value: OWNER_ADDRESS } },
						{ paramName: 'amount', typeValue: { type: 'unsignedInteger', value: 5n } },
					],
				},
			},
			{
				paramName: 'fills',
				typeValue: {
					type: 'tuple[]',
					value: [[
						{ paramName: 'token', typeValue: { type: 'address', value: TOKEN_ADDRESS } },
						{ paramName: 'amount', typeValue: { type: 'unsignedInteger', value: 7n } },
					]],
				},
			},
		])
	})

	test('parses decoded indexed tuple event args as topic hashes', () => {
		assertIndexedTupleHash(indexedTupleEvent, 'order')
		assertIndexedTupleHash(indexedTupleArrayEvent, 'orders')
	})

	test('keeps non-indexed 32-byte bytes values as bytes', () => {
		const variables = parseAbiParametersToSolidityVariables(bytes32LikeBytesAbiParameters, [INDEXED_TOPIC_HASH])
		const variable = variables[0]
		assert.equal(variable?.paramName, 'payload')
		assert.equal(variable?.typeValue.type, 'bytes')
		if (variable?.typeValue.type !== 'bytes') throw new Error('expected non-indexed bytes to parse as bytes')
		assert.equal(dataStringWith0xStart(variable.typeValue.value), INDEXED_TOPIC_HASH)
	})

	test('keeps non-indexed tuple objects with hash fields as tuples', () => {
		const variables = parseAbiParametersToSolidityVariables(tupleWithHashFieldAbiParameters, [{ hash: INDEXED_TOPIC_HASH }])
		const variable = variables[0]
		assert.equal(variable?.paramName, 'proof')
		assert.equal(variable?.typeValue.type, 'tuple')
		if (variable?.typeValue.type !== 'tuple') throw new Error('expected non-indexed hash field object to parse as tuple')
		const hashField = variable.typeValue.value[0]
		assert.equal(hashField?.paramName, 'hash')
		assert.equal(hashField?.typeValue.type, 'fixedBytes')
		if (hashField?.typeValue.type !== 'fixedBytes') throw new Error('expected hash field to parse as fixedBytes')
		assert.equal(dataStringWith0xStart(hashField.typeValue.value), INDEXED_TOPIC_HASH)
	})

	test('parses tuple and tuple array function calldata through parseInputData', async () => {
		const storageState: Record<string, unknown> = {
			userAddressBookEntriesV3: [
				{
					type: 'contract',
					name: 'Tuple Input Contract',
					address: TUPLE_INPUT_CONTRACT_ADDRESS_STRING,
					entrySource: 'User',
					abi: JSON.stringify(tupleInputFunctionAbi),
				},
			],
		}
		const restoreBrowser = installBrowserStorageMock(storageState)
		try {
			const input = encodeFunctionCall(tupleInputFunctionAbi, 'fulfill', [
				{ owner: toAddressHex(OWNER_ADDRESS), amount: 5n },
				[{ token: toAddressHex(TOKEN_ADDRESS), amount: 7n }],
			])
			const parsedInputData = await parseInputData({
				to: TUPLE_INPUT_CONTRACT_ADDRESS,
				value: 0n,
				input: EthereumData.parse(input),
			}, createTestEthereumClientService(), undefined)

			assert.equal(parsedInputData.type, 'Parsed')
			if (parsedInputData.type !== 'Parsed') throw new Error('expected calldata to parse')
			assert.equal(parsedInputData.name, 'fulfill')
			assert.deepEqual(parsedInputData.args, [
				{
					paramName: 'order',
					typeValue: {
						type: 'tuple',
						value: [
							{ paramName: 'owner', typeValue: { type: 'address', value: OWNER_ADDRESS } },
							{ paramName: 'amount', typeValue: { type: 'unsignedInteger', value: 5n } },
						],
					},
				},
				{
					paramName: 'fills',
					typeValue: {
						type: 'tuple[]',
						value: [[
							{ paramName: 'token', typeValue: { type: 'address', value: TOKEN_ADDRESS } },
							{ paramName: 'amount', typeValue: { type: 'unsignedInteger', value: 7n } },
						]],
					},
				},
			])
		} finally {
			restoreBrowser()
		}
	})

	test('parses Web3j ABIv2 example event struct parameters after log decoding', () => {
		const variables = parseDecodedEvent(
			web3jAbiV2ExampleEvent,
			[
				WEB3J_EVENT_ADDRESS,
				{ id: 'foo-id', name: 'Example Foo' },
				{ id: 15n, data: 'Example Bar' },
			],
			[toIndexedAddressTopic(WEB3J_EVENT_ADDRESS)],
		)

		assert.deepEqual(variables, [
			{ paramName: '_address', typeValue: { type: 'address', value: BigInt(WEB3J_EVENT_ADDRESS) } },
			{
				paramName: '_foo',
				typeValue: {
					type: 'tuple',
					value: [
						{ paramName: 'id', typeValue: { type: 'string', value: 'foo-id' } },
						{ paramName: 'name', typeValue: { type: 'string', value: 'Example Foo' } },
					],
				},
			},
			{
				paramName: '_bar',
				typeValue: {
					type: 'tuple',
					value: [
						{ paramName: 'id', typeValue: { type: 'unsignedInteger', value: 15n } },
						{ paramName: 'data', typeValue: { type: 'string', value: 'Example Bar' } },
					],
				},
			},
		])
	})

	test('parses OpenSea Seaport OrderFulfilled tuple array event args after log decoding', () => {
		const variables = parseDecodedEvent(
			seaportOrderFulfilledEvent,
			[
				INDEXED_TOPIC_HASH,
				OFFERER_ADDRESS,
				ZONE_ADDRESS,
				RECIPIENT_ADDRESS,
				[[2n, SEAPORT_TOKEN_ADDRESS, 123n, 1n]],
				[[0n, '0x0000000000000000000000000000000000000000', 0n, 100n, CONSIDERATION_RECIPIENT_ADDRESS]],
			],
			[],
		)

		assert.equal(variables[4]?.paramName, 'offer')
		assert.equal(variables[4]?.typeValue.type, 'tuple[]')
		if (variables[4]?.typeValue.type !== 'tuple[]') throw new Error('expected Seaport offer to parse as tuple[]')
		const offerToken = variables[4].typeValue.value[0]?.[1]
		assert.equal(offerToken?.paramName, 'token')
		assert.deepEqual(offerToken?.typeValue, { type: 'address', value: BigInt(SEAPORT_TOKEN_ADDRESS) })

		assert.equal(variables[5]?.paramName, 'consideration')
		assert.equal(variables[5]?.typeValue.type, 'tuple[]')
		if (variables[5]?.typeValue.type !== 'tuple[]') throw new Error('expected Seaport consideration to parse as tuple[]')
		const considerationRecipient = variables[5].typeValue.value[0]?.[4]
		assert.equal(considerationRecipient?.paramName, 'recipient')
		assert.deepEqual(considerationRecipient?.typeValue, { type: 'address', value: BigInt(CONSIDERATION_RECIPIENT_ADDRESS) })
	})
})
