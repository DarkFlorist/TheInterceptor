import * as assert from 'node:assert/strict'
import { test } from 'bun:test'
import { createBrowserSimulationRpc } from '../fixtures/browserSimulationRpc.js'
import { GNOSIS_SAFE_ABI } from '../../app/ts/gnosisSafe/gnosisSafeCore.js'
import { GNOSIS_SAFE_MESSAGE_ABI } from '../../app/ts/gnosisSafe/gnosisSafeMessage.js'
import { encodeStorageReaderCall, STORAGE_READER_ABI } from '../../app/ts/simulation/storageReader.js'
import { EthSimulateV1Result } from '../../app/ts/types/ethSimulate-types.js'
import { MULTICALL3, Multicall3ABI } from '../../app/ts/utils/constants.js'
import { encodeFunctionCall, encodeFunctionReturn } from '../../app/ts/utils/abiRuntime.js'
import { addressString, bytes32String, dataStringWith0xStart } from '../../app/ts/utils/bigint.js'

const safeAddress = 2n
const singletonAddress = 3n
const ownerAddress = 4n
const fixtureOptions = { safeAddress, singletonAddress, ownerAddress }

test('shared browser RPC preserves co-signing overrides for direct and simulated state reads', async () => {
	const messageCall = encodeFunctionCall(GNOSIS_SAFE_MESSAGE_ABI, 'getMessageHash', ['0x1234'])
	const messageResult = encodeFunctionReturn(GNOSIS_SAFE_MESSAGE_ABI, 'getMessageHash', [bytes32String(123n)])
	const rpc = createBrowserSimulationRpc({ ...fixtureOptions, extraCallResults: [[messageCall, messageResult]] })
	assert.deepEqual(rpc.safeStateReadCalls.map((call) => rpc.safeCallResults.get(call)), [
		encodeFunctionReturn(GNOSIS_SAFE_ABI, 'VERSION', ['1.4.1']),
		encodeFunctionReturn(GNOSIS_SAFE_ABI, 'nonce', [7n]),
		encodeFunctionReturn(GNOSIS_SAFE_ABI, 'getOwners', [[addressString(ownerAddress)]]),
		encodeFunctionReturn(GNOSIS_SAFE_ABI, 'getThreshold', [2n]),
	])
	// Co-signing scenarios change the fixture state after setup; every RPC path must observe that same owner.
	const nonceCall = encodeFunctionCall(GNOSIS_SAFE_ABI, 'nonce', [])
	const nonceResult = encodeFunctionReturn(GNOSIS_SAFE_ABI, 'nonce', [8n])
	rpc.safeCallResults.set(nonceCall, nonceResult)
	assert.equal(await rpc.handleRpcRequest({ id: 1, method: 'eth_call', params: [{ to: addressString(safeAddress), data: nonceCall }] }), nonceResult)
	assert.equal(await rpc.handleRpcRequest({ id: 2, method: 'eth_call', params: [{ to: addressString(safeAddress), data: messageCall }] }), messageResult)
	const batch = encodeFunctionCall(Multicall3ABI, 'aggregate3', [[nonceCall, messageCall].map((callData) => ({ target: addressString(safeAddress), allowFailure: false, callData }))])
	const blocks = EthSimulateV1Result.parse(await rpc.handleRpcRequest({ id: 3, method: 'eth_simulateV1', params: [{ blockStateCalls: [{ calls: [
		{ to: addressString(safeAddress), input: nonceCall },
		{ to: addressString(safeAddress), input: messageCall },
		{ to: addressString(MULTICALL3), input: batch },
	] }] }] }))
	assert.deepEqual(blocks[0]?.calls.map(({ returnData }) => dataStringWith0xStart(returnData)), [
		nonceResult,
		messageResult,
		encodeFunctionReturn(Multicall3ABI, 'aggregate3', [[{ success: true, returnData: nonceResult }, { success: true, returnData: messageResult }]]),
	])
})

test('shared browser RPC retains wallet simulation balances and native-host Safe discovery responses', async () => {
	const rpc = createBrowserSimulationRpc(fixtureOptions)
	const balanceCall = encodeFunctionCall(Multicall3ABI, 'getEthBalance', [addressString(ownerAddress)])
	const aggregateCall = encodeFunctionCall(Multicall3ABI, 'aggregate3', [[{ target: addressString(MULTICALL3), allowFailure: false, callData: balanceCall }]])
	const blocks = EthSimulateV1Result.parse(await rpc.handleRpcRequest({ id: 1, method: 'eth_simulateV1', params: [{ blockStateCalls: [{ calls: [
		{ to: addressString(MULTICALL3), input: aggregateCall },
		{ to: addressString(safeAddress), input: dataStringWith0xStart(encodeStorageReaderCall(0n)) },
	] }] }] }))
	assert.deepEqual(blocks[0]?.calls.map(({ returnData }) => dataStringWith0xStart(returnData)), [
		encodeFunctionReturn(Multicall3ABI, 'aggregate3', [[{ success: true, returnData: encodeFunctionReturn(Multicall3ABI, 'getEthBalance', [0n]) }]]),
		encodeFunctionReturn(STORAGE_READER_ABI, 'readSlot', [bytes32String(singletonAddress)]),
	])
	for (const address of [safeAddress, singletonAddress, MULTICALL3]) assert.equal(await rpc.handleRpcRequest({ id: 2, method: 'eth_getCode', params: [addressString(address)] }), '0x01')
	assert.equal(await rpc.handleRpcRequest({ id: 3, method: 'eth_getCode', params: [addressString(ownerAddress)] }), '0x')
	assert.equal(await rpc.handleRpcRequest({ id: 4, method: 'eth_getStorageAt', params: [addressString(safeAddress), '0x0'] }), bytes32String(singletonAddress))
	assert.equal(await rpc.handleRpcRequest({ id: 5, method: 'eth_chainId' }), '0x1')
	assert.equal(await rpc.handleRpcRequest({ id: 6, method: 'eth_estimateGas' }), '0x5208')
})
