import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import { JsonRpcResponse } from '../../app/ts/types/JsonRpc-types.js'
import { EthSimulateV1Params } from '../../app/ts/types/ethSimulate-types.js'
import { serialize, type EthereumSendableSignedTransaction } from '../../app/ts/types/wire-types.js'
import { eth_getBlockByNumber_goerli_8443561_true } from '../RPCResponses.js'

const rpcEntry = {
	name: 'Testnet',
	chainId: 1n,
	httpsRpc: 'https://example.invalid',
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	primary: true,
	minimized: true,
} as const

function parseRpcResult<T>(data: string): T {
	const response = JsonRpcResponse.parse(JSON.parse(data))
	if ('error' in response) throw new Error(`Ethereum Client Error: ${ response.error.message }`)
	return response.result as T
}

const fromAddress = 0x1111111111111111111111111111111111111111n
const toAddress = 0x2222222222222222222222222222222222222222n
const accessList = [{ address: toAddress, storageKeys: [0x33n] }]
const authorizationList = [{ chainId: 1n, address: toAddress, nonce: 2n, r: 3n, s: 4n, yParity: 'even' as const }]

function getSignedTransactionVariants(): readonly {
	name: string
	signedTransaction: EthereumSendableSignedTransaction
	assertions: (serializedCall: NonNullable<ReturnType<typeof getSerializedCall>>) => void
}[] {
	return [
		{
			name: 'legacy',
			signedTransaction: {
				type: 'legacy',
				from: fromAddress,
				nonce: 0n,
				gasPrice: 1n,
				gas: 21_000n,
				to: toAddress,
				value: 0n,
				input: new Uint8Array([0x12, 0x34]),
				chainId: 1n,
				r: 5n,
				s: 6n,
				v: 27n,
				hash: 0x1234n,
			},
			assertions: (serializedCall) => {
				assert.equal(serializedCall.type, '0x0')
				assert.equal(serializedCall.gasPrice, '0x1')
				assert.equal(serializedCall.v, '0x1b')
			},
		},
		{
			name: '2930',
			signedTransaction: {
				type: '2930',
				from: fromAddress,
				nonce: 0n,
				gasPrice: 1n,
				gas: 21_000n,
				to: toAddress,
				value: 0n,
				input: new Uint8Array([0x12, 0x34]),
				chainId: 1n,
				accessList,
				r: 0n,
				s: 0n,
				v: 0n,
				yParity: 'even',
				hash: 0x1235n,
			},
			assertions: (serializedCall) => {
				assert.equal(serializedCall.type, '0x1')
				assert.equal(serializedCall.yParity, '0x0')
				assert.equal(serializedCall.v, '0x0')
				assert.deepEqual(serializedCall.accessList, [{ address: '0x2222222222222222222222222222222222222222', storageKeys: ['0x0000000000000000000000000000000000000000000000000000000000000033'] }])
			},
		},
		{
			name: '1559',
			signedTransaction: {
				type: '1559',
				from: fromAddress,
				nonce: 0n,
				maxFeePerGas: 2n,
				maxPriorityFeePerGas: 1n,
				gas: 21_000n,
				to: toAddress,
				value: 0n,
				input: new Uint8Array([0x12, 0x34]),
				chainId: 1n,
				accessList,
				r: 0n,
				s: 0n,
				v: 0n,
				yParity: 'even',
				hash: 0x1236n,
			},
			assertions: (serializedCall) => {
				assert.equal(serializedCall.type, '0x2')
				assert.equal(serializedCall.maxFeePerGas, '0x2')
				assert.equal(serializedCall.maxPriorityFeePerGas, '0x1')
				assert.equal(serializedCall.yParity, '0x0')
				assert.equal(serializedCall.v, '0x0')
			},
		},
		{
			name: '4844',
			signedTransaction: {
				type: '4844',
				from: fromAddress,
				nonce: 0n,
				maxFeePerGas: 2n,
				maxPriorityFeePerGas: 1n,
				gas: 21_000n,
				to: toAddress,
				value: 0n,
				input: new Uint8Array([0x12, 0x34]),
				chainId: 1n,
				accessList,
				maxFeePerBlobGas: 7n,
				blobVersionedHashes: [0x44n],
				r: 0n,
				s: 0n,
				v: 0n,
				yParity: 'even',
				hash: 0x1237n,
			},
			assertions: (serializedCall) => {
				assert.equal(serializedCall.type, '0x3')
				assert.equal(serializedCall.maxFeePerBlobGas, '0x7')
				assert.deepEqual(serializedCall.blobVersionedHashes, ['0x0000000000000000000000000000000000000000000000000000000000000044'])
			},
		},
		{
			name: '7702',
			signedTransaction: {
				type: '7702',
				from: fromAddress,
				nonce: 0n,
				maxFeePerGas: 2n,
				maxPriorityFeePerGas: 1n,
				gas: 21_000n,
				to: toAddress,
				value: 0n,
				input: new Uint8Array([0x12, 0x34]),
				chainId: 1n,
				accessList,
				authorizationList,
				r: 0n,
				s: 0n,
				v: 0n,
				yParity: 'even',
				hash: 0x1238n,
			},
			assertions: (serializedCall) => {
				assert.equal(serializedCall.type, '0x4')
				assert.deepEqual(serializedCall.authorizationList, [{
					chainId: '0x1',
					address: '0x2222222222222222222222222222222222222222',
					nonce: '0x2',
					r: '0x3',
					s: '0x4',
					yParity: '0x0',
				}])
			},
		},
	]
}

function getSerializedCall(serializedRequest: ReturnType<typeof serialize<typeof EthSimulateV1Params>>) {
	return serializedRequest.params[0].blockStateCalls[0]?.calls[0]
}

describe('EthereumClientService eth_simulateV1 serialization', () => {
	test('builds JSON-safe eth_simulateV1 requests for all sendable transaction variants without internal hash fields', async () => {
		const service = new EthereumClientService(
			{
				rpcUrl: rpcEntry.httpsRpc,
				clearCache: () => undefined,
				async getChainId() { return rpcEntry.chainId },
				async jsonRpcRequest(request) {
					if (request.method !== 'eth_getBlockByNumber') throw new Error(`Unexpected RPC method: ${ request.method }`)
					return parseRpcResult(eth_getBlockByNumber_goerli_8443561_true)
				},
			},
			async () => undefined,
			async () => undefined,
			rpcEntry,
		)

		for (const variant of getSignedTransactionVariants()) {
			const prepared = await service.prepareEthSimulateV1Input([{
				stateOverrides: {},
				transactions: [{ signedTransaction: variant.signedTransaction }],
				signedMessages: [],
				blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 0n, deltaUnit: 'Seconds' },
				simulateWithZeroBaseFee: false,
			}], 1n, undefined)

			const serializedRequest = serialize(EthSimulateV1Params, prepared.request)
			const serializedCall = getSerializedCall(serializedRequest)
			if (serializedCall === undefined) throw new Error(`missing serialized eth_simulateV1 call for ${ variant.name }`)
			variant.assertions(serializedCall)
			const serialized = JSON.stringify(serializedRequest)
			assert.doesNotMatch(serialized, /"hash":/, `serialized ${ variant.name } call still contains internal hash`)
		}
	})
})
