import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { SAFE_ABI } from '../../app/ts/safe/safeCore.js'
import { getSafeSignatureRequirement } from '../../app/ts/safe/safeSignatureRequirement.js'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import { mockSignTransaction } from '../../app/ts/simulation/services/SimulationModeEthereumClientService.js'
import type { EthereumJsonRpcRequest } from '../../app/ts/types/JsonRpc-types.js'
import { EthSimulateV1Result } from '../../app/ts/types/ethSimulate-types.js'
import type { SimulationStateInput } from '../../app/ts/types/visualizer-types.js'
import { EthereumBlockHeader, EthereumQuantity, serialize } from '../../app/ts/types/wire-types.js'
import { encodeFunctionCall, encodeFunctionReturn } from '../../app/ts/utils/abiRuntime.js'
import { addressString, dataStringWith0xStart, stringToUint8Array } from '../../app/ts/utils/bigint.js'

const SAFE = 0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5afen
const USER = 0x1111111111111111111111111111111111111111n
const SECOND_OWNER = 0x2222222222222222222222222222222222222222n
const THIRD_OWNER = 0x3333333333333333333333333333333333333333n
const CHAIN_ID = 1337n

type SafeOwnership = { readonly owners: readonly bigint[], readonly threshold: bigint }
// What the Safe answers to an owner read, given how many eth_simulateV1 blocks run before the read: undefined reverts the call.
type OwnerReadAnswer = (stackBlockCount: number) => SafeOwnership | undefined

const parentBlock = {
	author: 0n,
	difficulty: 0n,
	extraData: new Uint8Array(),
	gasLimit: 30_000_000n,
	gasUsed: 21_000n,
	hash: 0x1000n,
	logsBloom: 0n,
	miner: 0n,
	mixHash: 0n,
	nonce: 0n,
	number: 123n,
	parentHash: 0x1n,
	receiptsRoot: 0n,
	sha3Uncles: 0n,
	stateRoot: 0n,
	timestamp: new Date('2024-01-01T00:00:00.000Z'),
	size: 0n,
	totalDifficulty: 0n,
	uncles: [],
	baseFeePerGas: 1n,
	transactionsRoot: 0n,
	transactions: [],
	withdrawals: [],
	withdrawalsRoot: 0n,
}

const replyToOwnerRead = (callData: string, ownership: SafeOwnership) => {
	if (callData === encodeFunctionCall(SAFE_ABI, 'getOwners', [])) return encodeFunctionReturn(SAFE_ABI, 'getOwners', [ownership.owners.map(addressString)])
	if (callData === encodeFunctionCall(SAFE_ABI, 'getThreshold', [])) return encodeFunctionReturn(SAFE_ABI, 'getThreshold', [ownership.threshold])
	throw new Error(`Unexpected Safe call ${ callData }`)
}

const succeededCall = (returnData: Uint8Array) => ({ status: 'success' as const, returnData, gasUsed: 21_000n, logs: [] })
const revertedCall = { status: 'failure' as const, returnData: new Uint8Array(), gasUsed: 21_000n, error: { code: 3, message: 'execution reverted' } }

// One block per stack block, each with one call, and the owner read as the call of the last block.
const simulatedBlocks = (blockCount: number, ownerRead: ReturnType<typeof succeededCall> | typeof revertedCall) => serialize(EthSimulateV1Result, Array.from({ length: blockCount }, (_, index) => ({
	number: 124n + BigInt(index),
	hash: 0x2000n + BigInt(index),
	timestamp: 0x65920080n + BigInt(index),
	gasLimit: 30_000_000n,
	gasUsed: 21_000n,
	baseFeePerGas: 1n,
	calls: [index === blockCount - 1 ? ownerRead : succeededCall(new Uint8Array())],
})))

// A node that runs every Safe read through eth_simulateV1 and refuses plain chain reads, so a reply can only come from the stack the read is given.
const createNode = (answerOwnerRead: OwnerReadAnswer) => {
	const handler = {
		rpcUrl: 'https://stub.invalid',
		clearCache: () => undefined,
		jsonRpcRequest: async (request: EthereumJsonRpcRequest) => {
			switch (request.method) {
				case 'eth_blockNumber': return serialize(EthereumQuantity, parentBlock.number)
				case 'eth_getBlockByNumber': return serialize(EthereumBlockHeader, parentBlock)
				case 'eth_getTransactionCount': return serialize(EthereumQuantity, 0n)
				case 'eth_simulateV1': {
					const blockStateCalls = request.params[0].blockStateCalls
					const readBlock = blockStateCalls[blockStateCalls.length - 1]
					const read = readBlock?.calls[readBlock.calls.length - 1]
					if (read === undefined || read.to !== SAFE || read.input === undefined) throw new Error('Expected a Safe owner read')
					const ownership = answerOwnerRead(blockStateCalls.length - 1)
					return simulatedBlocks(blockStateCalls.length, ownership === undefined ? revertedCall : succeededCall(stringToUint8Array(replyToOwnerRead(dataStringWith0xStart(read.input), ownership))))
				}
				default: throw new Error(`Unexpected RPC method ${ request.method }: owner reads must run on the simulation stack`)
			}
		},
	}
	return new EthereumClientService(handler, async () => undefined, async () => undefined, { name: 'Test', chainId: CHAIN_ID, httpsRpc: handler.rpcUrl, currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: true })
}

// A stack holding one transaction from the user, standing in for the deployment of a Safe the chain does not have.
const stackWithSafeDeployment: SimulationStateInput = [{
	stateOverrides: {},
	transactions: [{
		signedTransaction: mockSignTransaction({ type: '1559', from: USER, chainId: CHAIN_ID, nonce: 0n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, gas: 300_000n, to: null, value: 0n, input: new Uint8Array([0x60, 0x00]), accessList: [] }),
		website: { websiteOrigin: 'https://safe.example', icon: undefined, title: undefined },
		created: new Date('2024-01-01T00:00:00.000Z'),
		originalRequestParameters: { method: 'eth_sendTransaction', params: [{}] },
		transactionIdentifier: 1n,
	}],
	signedMessages: [],
	blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' },
	simulateWithZeroBaseFee: false,
}]

const readRequirement = async (answerOwnerRead: OwnerReadAnswer, simulationInput: SimulationStateInput = []) => await getSafeSignatureRequirement(createNode(answerOwnerRead), simulationInput, SAFE, [USER])

describe('Safe signature requirement', () => {
	test('a 1 of 1 Safe owned by the user needs only the user', async () => {
		assert.deepEqual(await readRequirement(() => ({ owners: [USER], threshold: 1n })), { threshold: 1n, ownerCount: 1n, userOwnerCount: 1n })
	})

	test('a 2 of 3 Safe with the user as one owner needs another owner too', async () => {
		assert.deepEqual(await readRequirement(() => ({ owners: [SECOND_OWNER, USER, THIRD_OWNER], threshold: 2n })), { threshold: 2n, ownerCount: 3n, userOwnerCount: 1n })
	})

	test('a failed owner read gives no requirement instead of an error', async () => {
		assert.equal(await readRequirement(() => undefined), undefined)
	})

	test('a reply that is not from a Safe gives no requirement', async () => {
		assert.equal(await readRequirement(() => ({ owners: [USER], threshold: 0n })), undefined)
		assert.equal(await readRequirement(() => ({ owners: [USER], threshold: 2n })), undefined)
	})

	test('a Safe that exists only on the simulation stack is read on top of that stack', async () => {
		const onlyOnStack: OwnerReadAnswer = (stackBlockCount) => stackBlockCount === 0 ? undefined : { owners: [USER, SECOND_OWNER], threshold: 2n }
		assert.equal(await readRequirement(onlyOnStack), undefined)
		assert.deepEqual(await readRequirement(onlyOnStack, stackWithSafeDeployment), { threshold: 2n, ownerCount: 2n, userOwnerCount: 1n })
	})
})
