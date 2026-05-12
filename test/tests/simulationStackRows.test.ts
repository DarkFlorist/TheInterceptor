import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { normalizeSimulationStackRows } from '../../app/ts/components/simulationExplaining/simulationStackRows.js'

describe('simulation stack rows', () => {
	test('message-only input produces a message row', () => {
		const blocks = normalizeSimulationStackRows([{
			stateOverrides: {},
			transactions: [],
			signedMessages: [{
				website: { websiteOrigin: 'https://example.com', title: 'Example', icon: undefined },
				created: new Date('2024-01-01T00:00:00.000Z'),
				fakeSignedFor: 0n,
				originalRequestParameters: { method: 'personal_sign', params: [] },
				request: { method: 'personal_sign', params: [] },
				simulationMode: true,
				messageIdentifier: 1n,
			} as any],
			blockTimeManipulation: { type: 'No Delay' },
			simulateWithZeroBaseFee: false,
		} as any], {
			success: true,
			visualizedBlocks: [{
				visualizedPersonalSignRequests: [],
				simulatedAndVisualizedTransactions: [],
				blockTimeManipulation: { type: 'No Delay' },
			} as any],
		} as any)

		assert.equal(blocks.length, 1)
		assert.equal(blocks[0]?.rows.length, 1)
		assert.equal(blocks[0]?.rows[0]?.type, 'Message')
		assert.equal(blocks[0]?.rows[0]?.status, 'pending')
	})

	test('normalize pending and simulated rows in input order', () => {
		const blocks = normalizeSimulationStackRows([
			{
				stateOverrides: {},
				transactions: [{
					signedTransaction: {
						type: '1559',
						from: 1n,
						to: 2n,
						value: 3n,
						input: new Uint8Array([0xde, 0xad]),
						nonce: 4n,
						gas: 5n,
						chainId: 1n,
						maxFeePerGas: 6n,
						maxPriorityFeePerGas: 7n,
					},
					website: { websiteOrigin: 'https://example.com', title: 'Example', icon: undefined },
					created: new Date('2024-01-01T00:00:00.000Z'),
					originalRequestParameters: { method: 'eth_sendTransaction', params: [] },
					transactionIdentifier: 11n,
				} as any],
				signedMessages: [{
					website: { websiteOrigin: 'https://example.com', title: 'Example', icon: undefined },
					created: new Date('2024-01-01T00:00:01.000Z'),
					fakeSignedFor: 0n,
					originalRequestParameters: { method: 'personal_sign', params: [] },
					request: { method: 'personal_sign', params: [] },
					simulationMode: true,
					messageIdentifier: 12n,
				} as any],
				blockTimeManipulation: { type: 'No Delay' },
				simulateWithZeroBaseFee: false,
			} as any,
		], {
			success: true,
			visualizedBlocks: [{
				visualizedPersonalSignRequests: [],
				simulatedAndVisualizedTransactions: [],
				blockTimeManipulation: { type: 'No Delay' },
			} as any],
		} as any)

		assert.equal(blocks.length, 1)
		assert.equal(blocks[0]?.rows.length, 2)
		assert.equal(blocks[0]?.rows[0]?.type, 'Message')
		assert.equal(blocks[0]?.rows[0]?.status, 'pending')
		assert.equal(blocks[0]?.rows[1]?.type, 'Transaction')
		assert.equal(blocks[0]?.rows[1]?.status, 'pending')
	})
})
