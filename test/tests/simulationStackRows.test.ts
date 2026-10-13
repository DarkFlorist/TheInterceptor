import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { normalizeSimulationStackRows } from '../../app/ts/components/simulationExplaining/simulationStackRows.js'
import { mockSignTransaction } from '../../app/ts/simulation/services/SimulationModeEthereumClientService.js'
import { SignedMessageTransaction, type PreSimulationTransaction, type SimulationStateInput, type VisualizedSimulationState } from '../../app/ts/types/visualizer-types.js'
import { getSignedMessageActiveAddress } from '../../app/ts/background/windows/personalSign.js'
import { DEFAULT_BLOCK_MANIPULATION } from '../../app/ts/config/defaults.js'
import type { InterceptedRequest } from '../../app/ts/utils/requests.js'

const interceptedPersonalSignRequest: InterceptedRequest = {
	method: 'personal_sign',
	params: ['0x', 0n],
	interceptorRequest: true,
	usingInterceptorWithoutSigner: false,
	uniqueRequestIdentifier: { requestId: 1, requestSocket: { tabId: 1, connectionName: 1n } },
}

describe('simulation stack rows', () => {
	test('loads messages persisted before active Safe addresses were stored separately', () => {
		const serializedMessage = SignedMessageTransaction.serialize({
			website: { websiteOrigin: 'https://example.com', title: 'Example', icon: undefined },
			created: new Date('2024-01-01T00:00:00.000Z'),
			activeAddress: 0x5678n,
			fakeSignedFor: 0x1234n,
			originalRequestParameters: { method: 'personal_sign', params: ['0x', 0x1234n] },
			request: {
				method: 'personal_sign',
				params: ['0x', 0x1234n],
				interceptorRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId: 1, requestSocket: { tabId: 1, connectionName: 1n } },
			},
			simulationMode: true,
			messageIdentifier: 1n,
		})
		assert.ok(typeof serializedMessage === 'object' && serializedMessage !== null)
		const legacySerializedMessage = Object.fromEntries(Object.entries(serializedMessage).filter(([key]) => key !== 'activeAddress'))
		const legacyMessage = SignedMessageTransaction.parse(legacySerializedMessage)

		assert.equal(legacyMessage.activeAddress, undefined)
		assert.equal(getSignedMessageActiveAddress(legacyMessage), legacyMessage.fakeSignedFor)
	})

	test('message-only input produces a message row', () => {
		const simulationStateInput: SimulationStateInput = [{
			stateOverrides: {},
			transactions: [],
			signedMessages: [{
				website: { websiteOrigin: 'https://example.com', title: 'Example', icon: undefined },
				created: new Date('2024-01-01T00:00:00.000Z'),
				activeAddress: 0n,
				fakeSignedFor: 0n,
				originalRequestParameters: { method: 'personal_sign', params: ['0x', 0n] },
				request: interceptedPersonalSignRequest,
				simulationMode: true,
				messageIdentifier: 1n,
			}],
			blockTimeManipulation: DEFAULT_BLOCK_MANIPULATION,
			simulateWithZeroBaseFee: false,
		}]
		const visualizedSimulationState: VisualizedSimulationState = {
			success: true,
			visualizedBlocks: [{
				visualizedPersonalSignRequests: [],
				simulatedAndVisualizedTransactions: [],
				blockTimeManipulation: DEFAULT_BLOCK_MANIPULATION,
			}],
		}
		const blocks = normalizeSimulationStackRows(simulationStateInput, visualizedSimulationState)

		assert.equal(blocks.length, 1)
		assert.equal(blocks[0]?.rows.length, 1)
		assert.equal(blocks[0]?.rows[0]?.type, 'Message')
		assert.equal(blocks[0]?.rows[0]?.status, 'pending')
	})

	test('normalize pending and simulated rows in input order', () => {
		const transactions: readonly PreSimulationTransaction[] = [{
			signedTransaction: mockSignTransaction({
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
			}),
			website: { websiteOrigin: 'https://example.com', title: 'Example', icon: undefined },
			created: new Date('2024-01-01T00:00:00.000Z'),
			originalRequestParameters: { method: 'eth_sendTransaction', params: [{ from: 1n, to: 2n, value: 3n, input: new Uint8Array([0xde, 0xad]), gas: 5n, maxFeePerGas: 6n, maxPriorityFeePerGas: 7n }] },
			transactionIdentifier: 11n,
		}]
		const signedMessages: readonly SignedMessageTransaction[] = [{
			website: { websiteOrigin: 'https://example.com', title: 'Example', icon: undefined },
			created: new Date('2024-01-01T00:00:01.000Z'),
			activeAddress: 0n,
			fakeSignedFor: 0n,
			originalRequestParameters: { method: 'personal_sign', params: ['0x', 0n] },
			request: interceptedPersonalSignRequest,
			simulationMode: true,
			messageIdentifier: 12n,
		}]
		const simulationStateInput: SimulationStateInput = [{
			stateOverrides: {},
			transactions,
			signedMessages,
			blockTimeManipulation: DEFAULT_BLOCK_MANIPULATION,
			simulateWithZeroBaseFee: false,
		}]
		const visualizedSimulationState: VisualizedSimulationState = {
			success: true,
			visualizedBlocks: [{
				visualizedPersonalSignRequests: [],
				simulatedAndVisualizedTransactions: [],
				blockTimeManipulation: DEFAULT_BLOCK_MANIPULATION,
			}],
		}
		const blocks = normalizeSimulationStackRows(simulationStateInput, visualizedSimulationState)

		assert.equal(blocks.length, 1)
		assert.equal(blocks[0]?.rows.length, 2)
		assert.equal(blocks[0]?.rows[0]?.type, 'Message')
		assert.equal(blocks[0]?.rows[0]?.status, 'pending')
		assert.equal(blocks[0]?.rows[1]?.type, 'Transaction')
		assert.equal(blocks[0]?.rows[1]?.status, 'pending')
	})
})
