import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import { mockSignTransaction } from '../../app/ts/simulation/services/simulationTransactionSigning.js'
import { EthereumBlockHeader } from '../../app/ts/types/wire-types.js'
import { JsonRpcResponse } from '../../app/ts/types/JsonRpc-types.js'
import type { SignedMessageTransaction, SimulationStateInputBlock } from '../../app/ts/types/visualizer-types.js'
import { addressString } from '../../app/ts/utils/bigint.js'
import { eth_getBlockByNumber_goerli_8443561_true } from '../RPCResponses.js'

const rpcUrl = 'https://example.invalid'
const ecRecoverAddress = addressString(1n)
const fakeSignerA = 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaan
const fakeSignerB = 0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbn
const sender = 0x1111111111111111111111111111111111111111n

const parentBlockResponse = JsonRpcResponse.parse(JSON.parse(eth_getBlockByNumber_goerli_8443561_true))
if (!('result' in parentBlockResponse)) throw new Error('fixture block response has no result')
const parentBlockGasLimit = EthereumBlockHeader.parse(parentBlockResponse.result).gasLimit

const service = new EthereumClientService(
	{
		rpcUrl,
		clearCache: () => undefined,
		async getChainId() { return 1n },
		async jsonRpcRequest(request) {
			if (request.method !== 'eth_getBlockByNumber') throw new Error(`Unexpected RPC method: ${ request.method }`)
			return parentBlockResponse.result
		},
	},
	async () => undefined,
	async () => undefined,
	{ name: 'Testnet', chainId: 1n, httpsRpc: rpcUrl, currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: true },
)

const createSignedMessage = (text: string, fakeSignedFor: bigint, messageIdentifier: bigint): SignedMessageTransaction => {
	const params: [string, bigint] = [`0x${ Buffer.from(text).toString('hex') }`, fakeSignedFor]
	return {
		website: { websiteOrigin: 'https://example.com', title: 'Example', icon: undefined },
		created: new Date('2024-01-01T00:00:00.000Z'),
		fakeSignedFor,
		originalRequestParameters: { method: 'personal_sign', params },
		request: { method: 'personal_sign', params },
		simulationMode: true,
		messageIdentifier,
	}
}

const createTransaction = (nonce: bigint, gas = 100_000n) => ({
	signedTransaction: mockSignTransaction({ type: '1559', from: sender, to: 1n, value: 0n, input: new Uint8Array(), nonce, gas, chainId: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 0n, accessList: [] }),
})

const createBlock = (signedMessages: readonly SignedMessageTransaction[], transactions: SimulationStateInputBlock['transactions']): SimulationStateInputBlock => ({
	stateOverrides: {},
	transactions,
	signedMessages,
	blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' },
	simulateWithZeroBaseFee: false,
})

const getEcRecoverOverrides = async (input: readonly SimulationStateInputBlock[]) => {
	const prepared = await service.prepareEthSimulateV1Input(input, 1n, undefined)
	return prepared.request.params[0].blockStateCalls.map((blockStateCall) => blockStateCall.stateOverrides?.[ecRecoverAddress])
}

// The storage slot and value a message maps to in the ecrecover override, read from a simulation where it is the only message.
const getMessageStorageEntry = async (signedMessage: SignedMessageTransaction) => {
	const [override] = await getEcRecoverOverrides([createBlock([signedMessage], [])])
	const entries = Object.entries(override?.state ?? {})
	const [entry] = entries
	if (entries.length !== 1 || entry === undefined) throw new Error('expected exactly one ecrecover storage entry for a single message')
	return entry
}

describe('ecrecover override across eth_simulateV1 blocks', () => {
	const messageA = createSignedMessage('message A', fakeSignerA, 1n)
	const messageB = createSignedMessage('message B', fakeSignerB, 2n)

	test('every block after a signed message keeps the override with all messages signed so far', async () => {
		const [slotA, signerA] = await getMessageStorageEntry(messageA)
		const [slotB, signerB] = await getMessageStorageEntry(messageB)
		assert.equal(signerA, fakeSignerA)
		assert.equal(signerB, fakeSignerB)

		const overrides = await getEcRecoverOverrides([
			createBlock([], [createTransaction(0n)]),
			createBlock([messageA], [createTransaction(1n)]),
			createBlock([messageB], [createTransaction(2n)]),
			createBlock([], [createTransaction(3n)]),
		])

		assert.equal(overrides[0], undefined, 'a block before any signed message should leave ecrecover untouched')
		for (const [index, override] of overrides.slice(1).entries()) {
			assert.notEqual(override, undefined, `block ${ index + 1 } should override ecrecover`)
			assert.equal(override?.movePrecompileToAddress, 0x123456n)
			assert.equal(override?.state?.[slotA], fakeSignerA, `block ${ index + 1 } should still verify the message signed in block 1`)
		}
		assert.equal(overrides[1]?.state?.[slotB], undefined, 'block 1 should not see a message signed later')
		assert.equal(overrides[2]?.state?.[slotB], fakeSignerB)
		assert.equal(overrides[3]?.state?.[slotB], fakeSignerB)
	})

	test('blocks split off by the gas limit keep the override of their input block', async () => {
		const [slotA] = await getMessageStorageEntry(messageA)
		const prepared = await service.prepareEthSimulateV1Input([
			createBlock([messageA], [createTransaction(0n, parentBlockGasLimit), createTransaction(1n, parentBlockGasLimit)]),
		], 1n, undefined)
		const { blockStateCalls } = prepared.request.params[0]

		assert.equal(blockStateCalls.length, 2)
		for (const [index, blockStateCall] of blockStateCalls.entries()) {
			assert.equal(blockStateCall.stateOverrides?.[ecRecoverAddress]?.state?.[slotA], fakeSignerA, `split block ${ index } should verify the message`)
		}
	})
})
