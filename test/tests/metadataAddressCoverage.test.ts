import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { getAddressesToIdentifyForVisualiserFromTransactions } from '../../app/ts/background/metadataUtils.js'
import { ETHEREUM_LOGS_LOGGER_ADDRESS } from '../../app/ts/utils/constants.js'
import { addressString } from '../../app/ts/utils/bigint.js'
import type { EnrichedEthereumEvents, EnrichedEthereumInputData, SolidityVariable } from '../../app/ts/types/EnrichedEthereumData.js'
import type { SendTransactionParams } from '../../app/ts/types/JsonRpc-types.js'
import type { SimulationStateInput } from '../../app/ts/types/visualizer-types.js'

const TOKEN_ADDRESS = 0x1000000000000000000000000000000000000001n
const FROM_ADDRESS = 0x2000000000000000000000000000000000000002n
const TO_ADDRESS = 0x3000000000000000000000000000000000000003n
const OPERATOR_ADDRESS = 0x4000000000000000000000000000000000000004n
const TX_FROM_ADDRESS = 0x5000000000000000000000000000000000000005n
const TX_TO_ADDRESS = 0x6000000000000000000000000000000000000006n
const INPUT_ADDRESS = 0x7000000000000000000000000000000000000007n
const STRUCT_OWNER_ADDRESS = 0x8000000000000000000000000000000000000008n
const STRUCT_TOKEN_ADDRESS = 0x9000000000000000000000000000000000000009n

const toAddressSet = (addresses: readonly bigint[]) => new Set(addresses.map((address) => addressString(address)))
const ZERO_BLOCK_TIME_MANIPULATION = { type: 'AddToTimestamp', deltaToAdd: 0n, deltaUnit: 'Seconds' } satisfies SimulationStateInput[number]['blockTimeManipulation']
const toAddressArg = (paramName: string, value: bigint): SolidityVariable => ({ paramName, typeValue: { type: 'address', value } })
const simulationWebsite = { websiteOrigin: 'https://example.com', icon: undefined, title: 'Example' }
const simulationCreated = new Date('2024-01-01T00:00:00.000Z')
const simulationOriginalRequestParameters: SendTransactionParams = { method: 'eth_sendTransaction', params: [{ from: TX_FROM_ADDRESS, to: TX_TO_ADDRESS, value: 0n, input: new Uint8Array() }] }

const getAddressesForEvent = (event: EnrichedEthereumEvents[number]) => {
	const inputData: readonly EnrichedEthereumInputData[] = [{
		type: 'Parsed',
		input: new Uint8Array(),
		name: 'transfer',
		args: [{ paramName: 'recipient', typeValue: { type: 'address', value: INPUT_ADDRESS } }],
	}]
	const simulationStateInput: SimulationStateInput = [{
		stateOverrides: {},
		signedMessages: [],
		blockTimeManipulation: ZERO_BLOCK_TIME_MANIPULATION,
		simulateWithZeroBaseFee: false,
		transactions: [{
			signedTransaction: {
				type: '1559',
				from: TX_FROM_ADDRESS,
				nonce: 0n,
				maxFeePerGas: 1n,
				maxPriorityFeePerGas: 1n,
				gas: 21_000n,
				to: TX_TO_ADDRESS,
				value: 0n,
				input: new Uint8Array(),
				chainId: 1n,
				hash: 1n,
				v: 1n,
				r: 1n,
				s: 1n,
			},
			website: simulationWebsite,
			created: simulationCreated,
			originalRequestParameters: simulationOriginalRequestParameters,
			transactionIdentifier: 1n,
		}],
	}]
	return getAddressesToIdentifyForVisualiserFromTransactions([event], inputData, simulationStateInput)
}

function assertCommonAddresses(addresses: readonly bigint[]) {
	const addressSet = toAddressSet(addresses)
	assert.equal(addressSet.has(addressString(TX_FROM_ADDRESS)), true)
	assert.equal(addressSet.has(addressString(TX_TO_ADDRESS)), true)
	assert.equal(addressSet.has(addressString(INPUT_ADDRESS)), true)
	assert.equal(addressSet.has(addressString(ETHEREUM_LOGS_LOGGER_ADDRESS)), true)
}

describe('getAddressesToIdentifyForVisualiserFromTransactions', () => {
	test('covers ERC20 Transfer addresses from parsed args and the emitter address', () => {
		const addresses = getAddressesForEvent({
			type: 'TokenEvent',
			address: TOKEN_ADDRESS,
			isParsed: 'Parsed',
			name: 'Transfer',
			signature: 'Transfer(address,address,uint256)',
			args: [toAddressArg('from', FROM_ADDRESS), toAddressArg('to', TO_ADDRESS)],
			loggersAddressBookEntry: { type: 'ERC20', name: 'Token', symbol: 'TOK', decimals: 18n, address: TOKEN_ADDRESS, entrySource: 'User' },
			data: new Uint8Array(),
			topics: [],
			logInformation: { type: 'ERC20', from: FROM_ADDRESS, to: TO_ADDRESS, tokenAddress: TOKEN_ADDRESS, amount: 1n, isApproval: false },
		})
		const addressSet = toAddressSet(addresses)
		assert.equal(addressSet.has(addressString(FROM_ADDRESS)), true)
		assert.equal(addressSet.has(addressString(TO_ADDRESS)), true)
		assert.equal(addressSet.has(addressString(TOKEN_ADDRESS)), true)
		assertCommonAddresses(addresses)
	})

	test('covers ERC20 Approval addresses from parsed args and the emitter address', () => {
		const addresses = getAddressesForEvent({
			type: 'TokenEvent',
			address: TOKEN_ADDRESS,
			isParsed: 'Parsed',
			name: 'Approval',
			signature: 'Approval(address,address,uint256)',
			args: [toAddressArg('owner', FROM_ADDRESS), toAddressArg('spender', TO_ADDRESS)],
			loggersAddressBookEntry: { type: 'ERC20', name: 'Token', symbol: 'TOK', decimals: 18n, address: TOKEN_ADDRESS, entrySource: 'User' },
			data: new Uint8Array(),
			topics: [],
			logInformation: { type: 'ERC20', from: FROM_ADDRESS, to: TO_ADDRESS, tokenAddress: TOKEN_ADDRESS, amount: 1n, isApproval: true },
		})
		const addressSet = toAddressSet(addresses)
		assert.equal(addressSet.has(addressString(FROM_ADDRESS)), true)
		assert.equal(addressSet.has(addressString(TO_ADDRESS)), true)
		assert.equal(addressSet.has(addressString(TOKEN_ADDRESS)), true)
		assertCommonAddresses(addresses)
	})

	test('covers WETH Deposit addresses from args plus the emitter address', () => {
		const addresses = getAddressesForEvent({
			type: 'TokenEvent',
			address: TOKEN_ADDRESS,
			isParsed: 'Parsed',
			name: 'Deposit',
			signature: 'Deposit(address,uint256)',
			args: [toAddressArg('dst', TO_ADDRESS)],
			loggersAddressBookEntry: { type: 'ERC20', name: 'Wrapped Ether', symbol: 'WETH', decimals: 18n, address: TOKEN_ADDRESS, entrySource: 'User' },
			data: new Uint8Array(),
			topics: [],
			logInformation: { type: 'ERC20', from: TOKEN_ADDRESS, to: TO_ADDRESS, tokenAddress: TOKEN_ADDRESS, amount: 1n, isApproval: false },
		})
		const addressSet = toAddressSet(addresses)
		assert.equal(addressSet.has(addressString(TOKEN_ADDRESS)), true)
		assert.equal(addressSet.has(addressString(TO_ADDRESS)), true)
		assertCommonAddresses(addresses)
	})

	test('covers WETH Withdrawal addresses from args plus the emitter address', () => {
		const addresses = getAddressesForEvent({
			type: 'TokenEvent',
			address: TOKEN_ADDRESS,
			isParsed: 'Parsed',
			name: 'Withdrawal',
			signature: 'Withdrawal(address,uint256)',
			args: [toAddressArg('src', FROM_ADDRESS)],
			loggersAddressBookEntry: { type: 'ERC20', name: 'Wrapped Ether', symbol: 'WETH', decimals: 18n, address: TOKEN_ADDRESS, entrySource: 'User' },
			data: new Uint8Array(),
			topics: [],
			logInformation: { type: 'ERC20', from: FROM_ADDRESS, to: TOKEN_ADDRESS, tokenAddress: TOKEN_ADDRESS, amount: 1n, isApproval: false },
		})
		const addressSet = toAddressSet(addresses)
		assert.equal(addressSet.has(addressString(FROM_ADDRESS)), true)
		assert.equal(addressSet.has(addressString(TOKEN_ADDRESS)), true)
		assertCommonAddresses(addresses)
	})

	test('covers ERC1155 TransferSingle addresses from parsed args and the emitter address', () => {
		const addresses = getAddressesForEvent({
			type: 'TokenEvent',
			address: TOKEN_ADDRESS,
			isParsed: 'Parsed',
			name: 'TransferSingle',
			signature: 'TransferSingle(address,address,address,uint256,uint256)',
			args: [toAddressArg('operator', OPERATOR_ADDRESS), toAddressArg('from', FROM_ADDRESS), toAddressArg('to', TO_ADDRESS)],
			loggersAddressBookEntry: { type: 'ERC1155', name: 'Collection', symbol: 'COLL', decimals: undefined, address: TOKEN_ADDRESS, entrySource: 'User' },
			data: new Uint8Array(),
			topics: [],
			logInformation: { type: 'ERC1155', from: FROM_ADDRESS, to: TO_ADDRESS, tokenAddress: TOKEN_ADDRESS, operator: OPERATOR_ADDRESS, tokenId: 1n, amount: 1n, isApproval: false },
		})
		const addressSet = toAddressSet(addresses)
		assert.equal(addressSet.has(addressString(FROM_ADDRESS)), true)
		assert.equal(addressSet.has(addressString(TO_ADDRESS)), true)
		assert.equal(addressSet.has(addressString(TOKEN_ADDRESS)), true)
		assert.equal(addressSet.has(addressString(OPERATOR_ADDRESS)), true)
		assertCommonAddresses(addresses)
	})

	test('covers ERC1155 TransferBatch addresses from parsed args and the emitter address', () => {
		const addresses = getAddressesForEvent({
			type: 'TokenEvent',
			address: TOKEN_ADDRESS,
			isParsed: 'Parsed',
			name: 'TransferBatch',
			signature: 'TransferBatch(address,address,address,uint256[],uint256[])',
			args: [toAddressArg('operator', OPERATOR_ADDRESS), toAddressArg('from', FROM_ADDRESS), toAddressArg('to', TO_ADDRESS)],
			loggersAddressBookEntry: { type: 'ERC1155', name: 'Collection', symbol: 'COLL', decimals: undefined, address: TOKEN_ADDRESS, entrySource: 'User' },
			data: new Uint8Array(),
			topics: [],
			logInformation: { type: 'ERC1155', from: FROM_ADDRESS, to: TO_ADDRESS, tokenAddress: TOKEN_ADDRESS, operator: OPERATOR_ADDRESS, tokenId: 2n, amount: 3n, isApproval: false },
		})
		const addressSet = toAddressSet(addresses)
		assert.equal(addressSet.has(addressString(FROM_ADDRESS)), true)
		assert.equal(addressSet.has(addressString(TO_ADDRESS)), true)
		assert.equal(addressSet.has(addressString(TOKEN_ADDRESS)), true)
		assert.equal(addressSet.has(addressString(OPERATOR_ADDRESS)), true)
		assertCommonAddresses(addresses)
	})

	test('covers addresses nested in tuple parsed args', () => {
		const addresses = getAddressesForEvent({
			type: 'Parsed',
			address: TOKEN_ADDRESS,
			isParsed: 'Parsed',
			name: 'OrderFilled',
			signature: 'OrderFilled((address,uint256),(address,uint256)[])',
			args: [
				{
					paramName: 'order',
					typeValue: {
						type: 'tuple',
						value: [
							toAddressArg('owner', STRUCT_OWNER_ADDRESS),
							{ paramName: 'amount', typeValue: { type: 'unsignedInteger', value: 1n } },
						],
					},
				},
				{
					paramName: 'fills',
					typeValue: {
						type: 'tuple[]',
						value: [[
							toAddressArg('token', STRUCT_TOKEN_ADDRESS),
							{ paramName: 'amount', typeValue: { type: 'unsignedInteger', value: 2n } },
						]],
					},
				},
			],
			loggersAddressBookEntry: { type: 'contract', name: 'Exchange', address: TOKEN_ADDRESS, entrySource: 'User' },
			data: new Uint8Array(),
			topics: [],
		})
		const addressSet = toAddressSet(addresses)
		assert.equal(addressSet.has(addressString(STRUCT_OWNER_ADDRESS)), true)
		assert.equal(addressSet.has(addressString(STRUCT_TOKEN_ADDRESS)), true)
		assert.equal(addressSet.has(addressString(TOKEN_ADDRESS)), true)
		assertCommonAddresses(addresses)
	})
})
