import { describe, test } from 'bun:test'
import * as assert from 'assert'
import { SAFE_ABI, assertSafeTxPreviewAllowed } from '../../app/ts/safe/safeCore.js'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import type { EthereumJsonRpcRequest } from '../../app/ts/types/JsonRpc-types.js'
import { encodeFunctionReturn } from '../../app/ts/utils/abiRuntime.js'
import { addressString, dataStringWith0xStart } from '../../app/ts/utils/bigint.js'
import { JsonRpcResponseError } from '../../app/ts/utils/errors.js'

const SAFE = 0x1111111111111111111111111111111111111111n
const OWNER = 0x2222222222222222222222222222222222222222n
const STRANGER = 0x3333333333333333333333333333333333333333n
const CHAIN_ID = 1n
const GET_OWNERS_SELECTOR = '0xa0e67e2b'

type CallReply = (selector: string) => string
const answeringAsSafe = (owners: readonly bigint[], threshold = 1n): CallReply => (selector) => selector === GET_OWNERS_SELECTOR
	? encodeFunctionReturn(SAFE_ABI, 'getOwners', [owners.map(addressString)])
	: encodeFunctionReturn(SAFE_ABI, 'getThreshold', [threshold])
const revertWith = (code: number, message: string): CallReply => () => { throw new JsonRpcResponseError({ jsonrpc: '2.0', id: 1, error: { code, message } }) }

const createNode = (replyToCall: CallReply) => {
	const handler = {
		rpcUrl: 'https://stub.invalid',
		clearCache: () => undefined,
		jsonRpcRequest: async (request: EthereumJsonRpcRequest) => {
			if (request.method === 'eth_blockNumber') return '0x7b'
			if (request.method !== 'eth_call') throw new Error(`Unexpected RPC method ${ request.method }`)
			return replyToCall(dataStringWith0xStart(request.params[0].data ?? new Uint8Array()).slice(0, 10))
		},
	}
	return new EthereumClientService(handler, async () => undefined, async () => undefined, { name: 'Test', chainId: CHAIN_ID, httpsRpc: handler.rpcUrl, currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: true })
}
const check = async (replyToCall: CallReply, activeAddress = OWNER, messageChainId: bigint | undefined = CHAIN_ID) => await assertSafeTxPreviewAllowed(createNode(replyToCall), SAFE, activeAddress, messageChainId)

describe('Safe preview check', () => {
	test('allows an owner of a contract answering as a Safe', async () => {
		await check(answeringAsSafe([STRANGER, OWNER], 2n))
	})

	test('allows a message without a chain id, as Safes before 1.3.0 sign', async () => {
		await check(answeringAsSafe([OWNER]), OWNER, undefined)
	})

	test('allows the named Safe itself as the active address, because the user chose it and the signer is configured on it', async () => {
		await check(answeringAsSafe([OWNER]), SAFE)
	})

	const notSafes: readonly (readonly [string, CallReply])[] = [
		['an address without code, or a contract whose fallback succeeds with nothing', () => '0x'],
		['a contract reverting with the code Geth and Reth use', revertWith(3, 'execution reverted')],
		['a contract reverting under another node\'s code', revertWith(-32000, 'VM Exception: Reverted')],
		['a reply too short for an address array', () => `0x${ '00'.repeat(31) }`],
		['an uninitialised Safe with no threshold', answeringAsSafe([OWNER], 0n)],
		['a threshold above the number of owners', answeringAsSafe([OWNER], 2n)],
	]
	for (const [name, replyToCall] of notSafes) {
		test(`refuses ${ name }`, async () => {
			await assert.rejects(check(replyToCall), /No outcome is simulated: 0x1111111111111111111111111111111111111111 is not a Gnosis Safe on this network/u)
		})
	}

	test('refuses an active address that is not an owner', async () => {
		await assert.rejects(check(answeringAsSafe([OWNER]), STRANGER), /0x3333333333333333333333333333333333333333 is not an owner of Gnosis Safe 0x1111111111111111111111111111111111111111/u)
	})

	test('refuses a message for another chain without asking the contract', async () => {
		await assert.rejects(check(() => { throw new Error('must not call') }, OWNER, 100n), /this message is for chain 100, not the selected network/u)
	})

	test('does not call a node failure a missing Safe', async () => {
		await assert.rejects(check(revertWith(-32005, 'rate limited')), /rate limited/u)
		await assert.rejects(check(() => { throw new Error('connection lost') }), /connection lost/u)
	})
})
