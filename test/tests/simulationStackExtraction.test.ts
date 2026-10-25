import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { getSimulatedStackV1, getSimulatedStackV2 } from '../../app/ts/simulation/SimulationStackExtraction.js'
import { mockSignTransaction } from '../../app/ts/simulation/services/SimulationModeEthereumClientService.js'
import { InterceptorMessageToInpage } from '../../app/ts/types/interceptor-messages.js'
import type { ResolvedSimulationState } from '../../app/ts/types/visualizer-types.js'
import { serialize } from '../../app/ts/types/wire-types.js'
import { ETHEREUM_LOGS_LOGGER_ADDRESS } from '../../app/ts/utils/constants.js'
import { addressString } from '../../app/ts/utils/bigint.js'

const SENDER = 0x1000000000000000000000000000000000000001n
const RECIPIENT = 0x2000000000000000000000000000000000000002n

const simulationStateWithBalanceBelowBaseFee: ResolvedSimulationState = {
	kind: 'simulated',
	value: {
		success: true,
		simulationOverrides: {},
		simulationStateInput: [],
		simulatedBlocks: [{
			stateOverrides: {},
			simulatedTransactions: [{
				realizedGasPrice: 2n,
				preSimulationTransaction: {
					signedTransaction: mockSignTransaction({
						type: '1559',
						from: SENDER,
						to: RECIPIENT,
						value: 0n,
						input: new Uint8Array(),
						nonce: 0n,
						gas: 21_000n,
						chainId: 1n,
						maxFeePerGas: 2n,
						maxPriorityFeePerGas: 1n,
					}),
					website: { websiteOrigin: 'https://example.com', icon: undefined, title: 'Example' },
					created: new Date('2026-01-01T00:00:00.000Z'),
					originalRequestParameters: { method: 'eth_sendTransaction', params: [{ from: SENDER, to: RECIPIENT }] },
					transactionIdentifier: 1n,
				},
				ethSimulateV1CallResult: {
					status: 'success',
					returnData: new Uint8Array(),
					gasUsed: 21_000n,
					logs: [],
				},
				tokenBalancesAfter: [{ token: ETHEREUM_LOGS_LOGGER_ADDRESS, tokenId: undefined, owner: SENDER, balance: 1n }],
			}],
			signedMessages: [],
			blockTimestamp: new Date('2026-01-01T00:00:00.000Z'),
			blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 0n, deltaUnit: 'Seconds' },
			blockBaseFeePerGas: 1n,
		}],
		blockNumber: 1n,
		blockTimestamp: new Date('2026-01-01T00:00:00.000Z'),
		baseFeePerGas: 1n,
		simulationConductedTimestamp: new Date('2026-01-01T00:00:00.000Z'),
		rpcNetwork: {
			name: 'Ethereum',
			chainId: 1n,
			httpsRpc: 'https://example.invalid',
			currencyName: 'Ether',
			currencyTicker: 'ETH',
			primary: true,
			minimized: false,
		},
	},
}

describe('simulation stack extraction', () => {
	test('version 1.0.1 remains serializable when the sender balance is below the base fee', () => {
		const payload = getSimulatedStackV1(simulationStateWithBalanceBelowBaseFee, undefined, '1.0.1')
		assert.equal(payload[0]?.balanceChanges[0]?.after, 0n)

		assert.doesNotThrow(() => serialize(InterceptorMessageToInpage, {
			type: 'result',
			interceptorApproved: true,
			bridgeRequestSettled: true,
			requestId: 1,
			method: 'interceptor_getSimulationStack',
			result: { version: '1.0.1', payload },
		}))
	})

	test('version 2.0.0 reports captured initial overrides when the stack has no simulated blocks', () => {
		if (simulationStateWithBalanceBelowBaseFee.kind !== 'simulated' || !simulationStateWithBalanceBelowBaseFee.value.success) throw new Error('Expected a successful simulated state')
		const delegateClearingOverrides = { [addressString(SENDER)]: { code: new Uint8Array() } }
		const emptyStackWithDelegateClearing: ResolvedSimulationState = {
			kind: 'simulated',
			value: { ...simulationStateWithBalanceBelowBaseFee.value, simulationOverrides: delegateClearingOverrides, simulatedBlocks: [] },
		}
		assert.deepEqual(getSimulatedStackV2(emptyStackWithDelegateClearing), { stateOverrides: delegateClearingOverrides, transactions: [] })
	})

	test('version 2.0.0 reports the first block overrides unchanged when they already include the initial overrides', () => {
		if (simulationStateWithBalanceBelowBaseFee.kind !== 'simulated' || !simulationStateWithBalanceBelowBaseFee.value.success) throw new Error('Expected a successful simulated state')
		const firstBlock = simulationStateWithBalanceBelowBaseFee.value.simulatedBlocks[0]
		if (firstBlock === undefined) throw new Error('Expected a simulated block')
		const firstBlockOverrides = { [addressString(SENDER)]: { balance: 5n, code: new Uint8Array() } }
		const stackWithDelegateClearing: ResolvedSimulationState = {
			kind: 'simulated',
			value: {
				...simulationStateWithBalanceBelowBaseFee.value,
				simulationOverrides: { [addressString(SENDER)]: { code: new Uint8Array() } },
				simulatedBlocks: [{ ...firstBlock, stateOverrides: firstBlockOverrides }],
			},
		}
		assert.deepEqual(getSimulatedStackV2(stackWithDelegateClearing).stateOverrides, firstBlockOverrides)
	})
})
