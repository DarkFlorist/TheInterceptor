import * as assert from 'node:assert'
import { test } from 'bun:test'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import { simulateCompoundGovernanceExecution } from '../../app/ts/simulation/compoundGovernanceFaking.js'
import { encodeFunctionReturn } from '../../app/ts/utils/abiRuntime.js'
import { addressString, stringToUint8Array } from '../../app/ts/utils/bigint.js'
import { EthSimulateV1Params, EthSimulateV1Result } from '../../app/ts/types/ethSimulate-types.js'
import { JsonRpcResponse } from '../../app/ts/types/JsonRpc-types.js'
import { serialize } from '../../app/ts/types/wire-types.js'
import { eth_getBlockByNumber_goerli_8443561_true, eth_simulateV1_dummy_call_result } from '../RPCResponses.js'

test('governance execution preserves clearing and timelock overrides', async () => {
	const activeAddress = 0x1234567890123456789012345678901234567890n
	const timelockAddress = 0xabcdefabcdefabcdefabcdefabcdefabcdefabcdn
	const governanceAddress = 0x9876543210987654321098765432109876543210n
	const governanceAbi = [
		{ type: 'function', name: 'timelock', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
		{ type: 'function', name: 'proposals', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ name: 'eta', type: 'uint256' }] },
		{ type: 'function', name: 'getActions', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [
			{ type: 'address[]' }, { type: 'uint256[]' }, { type: 'string[]' }, { type: 'bytes[]' },
		] },
	] as const
	const parentResponse = JsonRpcResponse.parse(JSON.parse(eth_getBlockByNumber_goerli_8443561_true))
	const simulationResponse = JsonRpcResponse.parse(JSON.parse(eth_simulateV1_dummy_call_result))
	if ('error' in parentResponse || 'error' in simulationResponse) throw new Error('Missing RPC fixture')
	const resultBlock = EthSimulateV1Result.parse(simulationResponse.result)[0]
	const resultCall = resultBlock?.calls[0]
	if (resultBlock === undefined || resultCall === undefined) throw new Error('Missing simulation result fixture')
	const governanceCalls = [
		{ ...resultCall, returnData: stringToUint8Array(encodeFunctionReturn(governanceAbi, 'timelock', [addressString(timelockAddress)])) },
		{ ...resultCall, returnData: stringToUint8Array(encodeFunctionReturn(governanceAbi, 'proposals', [2_000_000_000n])) },
		{ ...resultCall, returnData: stringToUint8Array(encodeFunctionReturn(governanceAbi, 'getActions', [[], [], [], []])) },
	]
	const requests: EthSimulateV1Params[] = []
	const ethereum = new EthereumClientService({
		rpcUrl: 'https://governance-test.invalid',
		clearCache() { return undefined },
		async jsonRpcRequest(request) {
			if (request.method === 'eth_getBlockByNumber') return parentResponse.result
			if (request.method === 'eth_simulateV1') {
				requests.push(request)
				return serialize(EthSimulateV1Result, [{ ...resultBlock, calls: requests.length === 1 ? governanceCalls : [resultCall] }])
			}
			throw new Error(`Unexpected RPC method ${ request.method }`)
		},
	}, async () => undefined, async () => undefined, {
		name: 'Governance test network', chainId: 1n, httpsRpc: 'https://governance-test.invalid', currencyName: 'Ether', currencyTicker: 'ETH', primary: false, minimized: false,
	})
	const simulationOverrides = { [addressString(activeAddress)]: { code: new Uint8Array() } }
	await simulateCompoundGovernanceExecution(ethereum, {
		type: 'contract', name: 'Governor', address: governanceAddress, entrySource: 'User', abi: JSON.stringify(governanceAbi),
	}, 1n, simulationOverrides)
	assert.equal(requests.length, 2)
	for (const request of requests) {
		const serialized = serialize(EthSimulateV1Params, request)
		assert.equal(serialized.params[0].blockStateCalls[0]?.stateOverrides?.[addressString(activeAddress)]?.code, '0x')
	}
	const executionRequest = serialize(EthSimulateV1Params, requests[1])
	assert.ok(executionRequest.params[0].blockStateCalls[0]?.stateOverrides?.[addressString(timelockAddress)]?.code?.startsWith('0x'))
})
