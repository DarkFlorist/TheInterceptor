import * as assert from 'node:assert'
import { test } from 'bun:test'
import multiSendLibrary from '../fixtures/safe-libraries/MultiSendCallOnly.json'
import signMessageLibrary from '../fixtures/safe-libraries/SignMessageLib.json'
import { createSafeTx, assertInterceptorSafeTransactionPolicy } from '../../app/ts/safe/safeCore.js'
import { encodeSafeBatch, decodeSafeBatch, validateSafeDelegateCode, SAFE_MULTI_SEND_CALL_ONLY, SAFE_MULTI_SEND_ABI, SAFE_SIGN_MESSAGE_LIB, SAFE_SIGN_MESSAGE_ABI, type SafeBatchCall } from '../../app/ts/safe/safeDelegateCalls.js'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import type { IEthereumJSONRpcRequestHandler } from '../../app/ts/simulation/services/EthereumJSONRpcRequestHandler.js'
import type { RpcEntry } from '../../app/ts/types/rpc.js'
import type { EthereumBlockTag } from '../../app/ts/types/wire-types.js'
import { encodeFunctionCall } from '../../app/ts/utils/abiRuntime.js'
import { stringToUint8Array } from '../../app/ts/utils/bigint.js'
import type { Hex } from '../../app/ts/utils/ethereumBytes.js'

const firstCall: SafeBatchCall = { to: 42n, value: 0n, data: new Uint8Array([1, 2]) }
const secondCall: SafeBatchCall = { to: 43n, value: 123n, data: new Uint8Array() }
const calls = [firstCall, secondCall]
const batch = () => createSafeTx(1n, 123n, { to: SAFE_MULTI_SEND_CALL_ONLY, operation: 1n, value: 0n, input: encodeSafeBatch(calls) }, 7n)

const mainnetRpcEntry = {
	name: 'Ethereum',
	chainId: 1n,
	httpsRpc: 'https://safe-delegate-calls.test',
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	primary: true,
	minimized: false,
} satisfies RpcEntry

// Delegate-code validation reads the chain only through getCode. EthereumClientService defines it as a per-instance function property, so a real client with getCode replaced keeps the class type while the stub keeps the real signature; any other RPC request fails the test.
function createEthereumWithCode(getCode: EthereumClientService['getCode']) {
	const rejectingRequestHandler: IEthereumJSONRpcRequestHandler = {
		rpcUrl: mainnetRpcEntry.httpsRpc,
		clearCache: () => undefined,
		getChainId: async () => mainnetRpcEntry.chainId,
		jsonRpcRequest: async (request) => { throw new Error(`Unexpected RPC request: ${ request.method }`) },
	}
	return Object.assign(new EthereumClientService(rejectingRequestHandler, async () => undefined, async () => undefined, mainnetRpcEntry), { getCode })
}

test('Safe batch retains call order and values in one constrained delegate proposal', () => {
	assert.deepEqual(decodeSafeBatch(batch().message.data), calls)
	assert.doesNotThrow(() => assertInterceptorSafeTransactionPolicy(batch()))
	assert.throws(() => assertInterceptorSafeTransactionPolicy({ ...batch(), message: { ...batch().message, value: 1n } }), /zero outer value/)
	assert.throws(() => encodeSafeBatch([firstCall]), /between 2 and 100/)
	assert.throws(() => encodeSafeBatch(Array.from({ length: 101 }, () => firstCall)), /between 2 and 100/)
	assert.throws(() => encodeSafeBatch([{ ...firstCall, to: 0n }, secondCall]), /destination/)
	assert.throws(() => encodeSafeBatch([{ ...firstCall, data: new Uint8Array(100_000) }, secondCall]), /encoded bytes/)
	const malformedPackedBatches: readonly Hex[] = [`0x01${ '00'.repeat(84) }`, '0x00', `0x${ '00'.repeat(84) }01`]
	for (const packed of malformedPackedBatches) {
		assert.throws(() => decodeSafeBatch(stringToUint8Array(encodeFunctionCall(SAFE_MULTI_SEND_ABI, 'multiSend', [packed]))))
	}
	assert.throws(() => decodeSafeBatch(new Uint8Array([...batch().message.data, 0])), /canonical/)
})

test('delegate proposals require the exact deployed Safe library bytecode at the review block', async () => {
	const requestedBlocks: EthereumBlockTag[] = []
	for (const [safeTx, library] of [
		[batch(), multiSendLibrary],
		[createSafeTx(1n, 123n, { to: SAFE_SIGN_MESSAGE_LIB, operation: 1n, value: 0n, input: stringToUint8Array(encodeFunctionCall(SAFE_SIGN_MESSAGE_ABI, 'signMessage', [`0x${ '12'.repeat(32) }`])) }, 7n), signMessageLibrary],
	] as const) {
		await validateSafeDelegateCode(createEthereumWithCode(async (_address, block) => { requestedBlocks.push(block); return stringToUint8Array(library.deployedBytecode) }), safeTx, 100n)
		await assert.rejects(validateSafeDelegateCode(createEthereumWithCode(async () => new Uint8Array()), safeTx, 100n), /missing or has unexpected bytecode/)
		await assert.rejects(validateSafeDelegateCode(createEthereumWithCode(async () => new Uint8Array([1])), safeTx, 100n), /unexpected bytecode/)
	}
	assert.deepEqual(requestedBlocks, [100n, 100n])
})

test('SignMessageLib uses the canonical bytes selector and dynamic argument layout', () => {
	const digest = '12'.repeat(32)
	// Independent ABI vector for the v1.4.1 contract cited beside SAFE_SIGN_MESSAGE_ABI: selector, offset, byte length, payload.
	const expected = '0x85a5affe' + '0'.repeat(62) + '20' + '0'.repeat(62) + '20' + digest
	assert.equal(encodeFunctionCall(SAFE_SIGN_MESSAGE_ABI, 'signMessage', [`0x${ digest }`]), expected)
	const proposal = createSafeTx(1n, 123n, { to: SAFE_SIGN_MESSAGE_LIB, operation: 1n, value: 0n, input: stringToUint8Array(expected) }, 7n)
	assert.doesNotThrow(() => assertInterceptorSafeTransactionPolicy(proposal))
	// signMessage(bytes32) has a different selector and is not an entry point of the deployed library.
	assert.throws(() => assertInterceptorSafeTransactionPolicy({ ...proposal, message: { ...proposal.message, data: stringToUint8Array(`0xa08519b5${ digest }`) } }))
})
