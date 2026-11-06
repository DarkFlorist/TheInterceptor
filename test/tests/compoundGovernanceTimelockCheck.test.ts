import { describe, test } from 'bun:test'
import * as assert from 'assert'
import { simulateCompoundGovernanceExecution } from '../../app/ts/simulation/compoundGovernanceFaking.js'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import type { AddressBookEntry } from '../../app/ts/types/addressBookTypes.js'
import { EthSimulateV1Result } from '../../app/ts/types/ethSimulate-types.js'
import type { EthereumJsonRpcRequest } from '../../app/ts/types/JsonRpc-types.js'
import { EthereumBlockHeader } from '../../app/ts/types/wire-types.js'
import { GovernanceTimelockReadsAbi } from '../../app/ts/utils/abi.js'
import { encodeFunctionCall, encodeFunctionReturn } from '../../app/ts/utils/abiRuntime.js'
import { addressString, dataStringWith0xStart, stringToUint8Array } from '../../app/ts/utils/bigint.js'
import { JsonRpcResponseError } from '../../app/ts/utils/errors.js'

const GOVERNOR = 0x1111111111111111111111111111111111111111n
const TIMELOCK = 0x2222222222222222222222222222222222222222n
const SOMEONE_ELSE = 0x3333333333333333333333333333333333333333n
const LATEST_BLOCK_NUMBER = 123n
const LATEST_BLOCK_TIMESTAMP = new Date('2024-01-01T00:00:00.000Z')
const PROPOSAL_ETA = 1_704_153_600n
const ADMIN_READ = encodeFunctionCall(GovernanceTimelockReadsAbi, 'admin', [])
const PROPOSER_ROLE = '0xb09aa5aeb3702cfd50b6b62bc4532604938f21248a27a1d5ca736082b6819cc1'
const IS_GOVERNOR_PROPOSER_READ = encodeFunctionCall(GovernanceTimelockReadsAbi, 'hasRole', [PROPOSER_ROLE, addressString(GOVERNOR)])

const GOVERNOR_ABI = [
	{ type: 'function', name: 'timelock', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
	{ type: 'function', name: 'proposals', stateMutability: 'view', inputs: [{ name: 'id', type: 'uint256' }], outputs: [{ name: 'id', type: 'uint256' }, { name: 'eta', type: 'uint256' }] },
	{
		type: 'function',
		name: 'getActions',
		stateMutability: 'view',
		inputs: [{ name: 'id', type: 'uint256' }],
		outputs: [{ name: 'targets', type: 'address[]' }, { name: 'values', type: 'uint256[]' }, { name: 'signatures', type: 'string[]' }, { name: 'calldatas', type: 'bytes[]' }],
	},
] as const
const governorEntry: AddressBookEntry = { type: 'contract', name: 'Governor', address: GOVERNOR, entrySource: 'User', abi: JSON.stringify(GOVERNOR_ABI) }

const latestBlock = EthereumBlockHeader.serialize({
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
	number: LATEST_BLOCK_NUMBER,
	parentHash: 0x1n,
	receiptsRoot: 0n,
	sha3Uncles: 0n,
	stateRoot: 0n,
	timestamp: LATEST_BLOCK_TIMESTAMP,
	size: 0n,
	totalDifficulty: 0n,
	uncles: [],
	baseFeePerGas: 1n,
	transactionsRoot: 0n,
	transactions: [],
	withdrawals: [],
	withdrawalsRoot: 0n,
})

const simulatedBlock = (returnDatas: readonly string[]) => EthSimulateV1Result.serialize([{
	number: LATEST_BLOCK_NUMBER + 1n,
	hash: 0x2000n,
	timestamp: 0x65920080n,
	gasLimit: 30_000_000n,
	gasUsed: 21_000n,
	baseFeePerGas: 1n,
	calls: returnDatas.map((returnData) => ({ status: 'success' as const, returnData: stringToUint8Array(returnData), gasUsed: 21_000n, maxUsedGas: 21_000n, logs: [] })),
}])

const governorReads = simulatedBlock([
	encodeFunctionReturn(GOVERNOR_ABI, 'timelock', [addressString(TIMELOCK)]),
	encodeFunctionReturn(GOVERNOR_ABI, 'proposals', [1n, PROPOSAL_ETA]),
	encodeFunctionReturn(GOVERNOR_ABI, 'getActions', [[addressString(SOMEONE_ELSE)], [0n], [''], ['0x']]),
])

type TimelockReply = (callData: string) => string
// Compound's Timelock has an empty payable fallback, so a read it does not implement succeeds with nothing instead of reverting.
const answerOnlyAdmin = (admin: bigint): TimelockReply => (callData) => {
	if (callData === ADMIN_READ) return encodeFunctionReturn(GovernanceTimelockReadsAbi, 'admin', [addressString(admin)])
	return '0x'
}
const answerOnlyHasRole = (isProposer: boolean): TimelockReply => (callData) => {
	if (callData === IS_GOVERNOR_PROPOSER_READ) return encodeFunctionReturn(GovernanceTimelockReadsAbi, 'hasRole', [isProposer])
	return failWithRpcError(3, 'execution reverted')(callData)
}
const failWithRpcError = (code: number, message: string): TimelockReply => () => { throw new JsonRpcResponseError({ jsonrpc: '2.0', id: 1, error: { code, message } }) }

const previewWithTimelockReplying = async (replyToTimelockRead: TimelockReply) => {
	const simulations: string[] = []
	const timelockReadBlocks: unknown[] = []
	const handler = {
		rpcUrl: 'https://stub.invalid',
		clearCache: () => undefined,
		getChainId: async () => 1n,
		jsonRpcRequest: async (request: EthereumJsonRpcRequest) => {
			switch (request.method) {
				case 'eth_getBlockByNumber': return latestBlock
				case 'eth_call': {
					assert.equal(request.params[0].to, TIMELOCK)
					timelockReadBlocks.push(request.params[1])
					return replyToTimelockRead(dataStringWith0xStart(request.params[0].data ?? new Uint8Array()))
				}
				case 'eth_simulateV1': {
					simulations.push(JSON.stringify(request.params[0].blockStateCalls[0]?.stateOverrides, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value))
					return simulations.length === 1 ? governorReads : simulatedBlock(['0x'])
				}
				default: throw new Error(`Unexpected RPC method ${ request.method }`)
			}
		},
	}
	const ethereum = new EthereumClientService(handler, async () => undefined, async () => undefined, { name: 'Test', chainId: 1n, httpsRpc: handler.rpcUrl, currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: true })
	const preview = simulateCompoundGovernanceExecution(ethereum, governorEntry, 1n)
	return { preview, simulations, timelockReadBlocks }
}

describe('Compound governance preview timelock check', () => {
	const realTimelocks: readonly (readonly [string, TimelockReply])[] = [
		['a Compound Timelock with the governor as admin', answerOnlyAdmin(GOVERNOR)],
		['a TimelockController with the governor as proposer', answerOnlyHasRole(true)],
	]
	for (const [name, replyToTimelockRead] of realTimelocks) {
		test(`simulates the proposal at ${ name }`, async () => {
			const { preview, simulations, timelockReadBlocks } = await previewWithTimelockReplying(replyToTimelockRead)
			const result = await preview
			assert.ok(Object.keys(result.executionStateOverrides).includes(addressString(TIMELOCK)))
			assert.equal(simulations.length, 2)
			assert.ok(timelockReadBlocks.every((block) => block === LATEST_BLOCK_NUMBER))
		})
	}

	const notTheTimelock: readonly (readonly [string, TimelockReply])[] = [
		['an address without code, or a contract whose fallback succeeds with nothing', () => '0x'],
		['a contract reverting with the code Geth and Reth use', failWithRpcError(3, 'execution reverted')],
		['a contract reverting under another node\'s code', failWithRpcError(-32000, 'VM Exception: Reverted')],
		['a reply too short for an address', () => `0x${ '00'.repeat(31) }`],
		['a Compound Timelock with another admin', answerOnlyAdmin(SOMEONE_ELSE)],
		['a TimelockController that does not list the governor as proposer', answerOnlyHasRole(false)],
	]
	for (const [name, replyToTimelockRead] of notTheTimelock) {
		test(`refuses ${ name } before placing any code`, async () => {
			const { preview, simulations } = await previewWithTimelockReplying(replyToTimelockRead)
			await assert.rejects(preview, /No outcome is simulated: 0x2222222222222222222222222222222222222222 does not name 0x1111111111111111111111111111111111111111 as its admin or proposer, so it cannot be confirmed as this contract's timelock/u)
			assert.equal(simulations.length, 1)
		})
	}

	test('does not call a node failure a wrong timelock', async () => {
		const rateLimited = await previewWithTimelockReplying(failWithRpcError(-32005, 'rate limited'))
		await assert.rejects(rateLimited.preview, /rate limited/u)
		const connectionLost = await previewWithTimelockReplying(() => { throw new Error('connection lost') })
		await assert.rejects(connectionLost.preview, /connection lost/u)
	})
})
