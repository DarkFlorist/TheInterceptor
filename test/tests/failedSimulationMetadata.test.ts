import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import type { SimulationState } from '../../app/ts/types/visualizer-types.js'
import { withSilencedConsole } from './consoleSilence.js'
import { createPerTestRestorer } from '../harness/perTest.js'
import { createStubEthereumClient, rejectRpcRequest, stubRpcNetwork } from './stubEthereumClient.js'

const { installBrowserMockForTest } = createPerTestRestorer()

const { ETHEREUM_LOGS_LOGGER_ADDRESS, NEW_BLOCK_ABORT } = await import('../../app/ts/utils/constants.js')
const { visualizeSimulatorState } = await import('../../app/ts/background/simulationUpdating.js')
const { TokenPriceService } = await import('../../app/ts/simulation/services/priceEstimator.js')
const { getLatestUnexpectedError } = await import('../../app/ts/utils/unexpectedErrorStorage.js')
const { identifyAddress } = await import('../../app/ts/background/metadataUtils.js')
const { JsonRpcResponseError } = await import('../../app/ts/utils/errors.js')

describe('visualizeSimulatorState failed simulations', () => {
	test('recovers JSON-RPC metadata probe failures without hiding unexpected metadata errors', async () => {
		installBrowserMockForTest()
		const rpcNetwork = stubRpcNetwork
		const baseEthereum = createStubEthereumClient(async () => { throw new Error('Unexpected direct RPC request') }, rpcNetwork)
		// The simulation has no token transfers, so price estimation never queries the node.
		const tokenPriceService = new TokenPriceService(baseEthereum, 0)
		const ethereum = new Proxy(baseEthereum, {
			get(target, property, receiver) {
				if (property === 'getCode') return async () => new Uint8Array([1])
				if (property === 'ethSimulateV1') return async () => {
					throw new JsonRpcResponseError({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'err: intrinsic gas too low: have 11332, want 21240 (supplied gas 11332)' } })
				}
				return Reflect.get(target, property, receiver)
			},
		})
		const targetAddress = 0x1234567890123456789012345678901234567890n
		const created = new Date('2024-01-01T00:00:00.000Z')
		const transaction = {
			signedTransaction: {
				type: '1559' as const,
				from: 0n,
				nonce: 0n,
				maxFeePerGas: 1n,
				maxPriorityFeePerGas: 1n,
				gas: 100_000n,
				to: targetAddress,
				value: 0n,
				input: new Uint8Array(),
				chainId: rpcNetwork.chainId,
				hash: 1n,
				v: 1n,
				r: 1n,
				s: 1n,
			},
			website: { websiteOrigin: 'https://example.com', icon: undefined, title: 'Example' },
			created,
			originalRequestParameters: { method: 'eth_sendTransaction' as const, params: [{ from: 0n, to: targetAddress }] as const },
			transactionIdentifier: 1n,
		}
		const simulationState: SimulationState = {
			success: true,
			simulationStateInput: [{
				stateOverrides: {},
				transactions: [transaction],
				signedMessages: [],
				blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 0n, deltaUnit: 'Seconds' },
				simulateWithZeroBaseFee: false,
			}],
			simulatedBlocks: [],
			blockNumber: 1n,
			blockTimestamp: created,
			baseFeePerGas: 1n,
			simulationConductedTimestamp: created,
			rpcNetwork,
		}
		const { directlyIdentifiedEntry, visualized } = await withSilencedConsole(async () => ({
			directlyIdentifiedEntry: await identifyAddress(ethereum, undefined, targetAddress),
			visualized: await visualizeSimulatorState(simulationState, ethereum, tokenPriceService, undefined),
		}))

		const targetEntry = visualized.addressBookEntries.find((entry) => entry.address === targetAddress)
		assert.equal(directlyIdentifiedEntry.entrySource, 'FilledIn')
		assert.equal(targetEntry?.entrySource, 'FilledIn')
		assert.equal(targetEntry?.chainId, rpcNetwork.chainId)
		assert.equal(visualized.visualizedSimulationState.success, true)

		const unexpectedEthereum = new Proxy(baseEthereum, {
			get(target, property, receiver) {
				if (property === 'getCode') return async () => new Uint8Array([1])
				if (property === 'ethSimulateV1') return async () => { throw new Error('unexpected metadata defect') }
				return Reflect.get(target, property, receiver)
			},
		})
		await assert.rejects(async () => await identifyAddress(unexpectedEthereum, undefined, targetAddress), /unexpected metadata defect/)
		await assert.rejects(
			async () => await visualizeSimulatorState(simulationState, unexpectedEthereum, tokenPriceService, undefined),
			/unexpected metadata defect/,
		)
	})

	test('keeps fetched address metadata instead of returning an empty address book', async () => {
		installBrowserMockForTest()

		const rpcNetwork = stubRpcNetwork

		const ethereum = createStubEthereumClient(async (request) => {
			if (request.method === 'eth_getCode') return '0x'
			return await rejectRpcRequest(request)
		}, rpcNetwork)

		const created = new Date('2024-01-01T00:00:00.000Z')
		const failedSimulationState: SimulationState = {
			success: false,
			simulationStateInput: [{
				stateOverrides: {},
				transactions: [{
					signedTransaction: {
						type: '1559',
						from: 0n,
						nonce: 0n,
						maxFeePerGas: 1n,
						maxPriorityFeePerGas: 1n,
						gas: 21_000n,
						to: ETHEREUM_LOGS_LOGGER_ADDRESS,
						value: 0n,
						input: new Uint8Array(),
						chainId: rpcNetwork.chainId,
						hash: 1n,
						v: 1n,
						r: 1n,
						s: 1n,
					},
					website: { websiteOrigin: 'https://example.com', icon: undefined, title: 'Example' },
					created,
					originalRequestParameters: { method: 'eth_sendTransaction', params: [{ from: 0n, to: ETHEREUM_LOGS_LOGGER_ADDRESS, value: 0n, input: new Uint8Array() }] },
					transactionIdentifier: 1n,
				}],
				signedMessages: [],
				blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 0n, deltaUnit: 'Seconds' },
				simulateWithZeroBaseFee: false,
			}],
			jsonRpcError: { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'simulation failed' } },
			blockNumber: 1n,
			blockTimestamp: created,
			baseFeePerGas: 1n,
			simulationConductedTimestamp: created,
			rpcNetwork,
		}

		const visualized = await visualizeSimulatorState(failedSimulationState, ethereum, new TokenPriceService(ethereum, 0), undefined)

		assert.equal(visualized.addressBookEntries.length, 2)
		assert.equal(visualized.addressBookEntries.some((entry) => entry.address === 0n), true)
		assert.equal(visualized.addressBookEntries.some((entry) => entry.address === ETHEREUM_LOGS_LOGGER_ADDRESS), true)
		assert.equal(visualized.visualizedSimulationState.success, false)
		assert.equal(visualized.visualizedSimulationState.visualizedBlocks[0]?.simulatedAndVisualizedTransactions[0]?.transaction.from.address, 0n)
		assert.equal(visualized.visualizedSimulationState.visualizedBlocks[0]?.simulatedAndVisualizedTransactions[0]?.transaction.to?.address, ETHEREUM_LOGS_LOGGER_ADDRESS)
	})

	test('propagates new-block aborts during delegation lookup without recording an unexpected error', async () => {
		installBrowserMockForTest()

		const rpcNetwork = stubRpcNetwork

		const ethereum = createStubEthereumClient(async (request) => {
			if (request.method === 'eth_getCode') throw NEW_BLOCK_ABORT
			return await rejectRpcRequest(request)
		}, rpcNetwork)

		const created = new Date('2024-01-01T00:00:00.000Z')
		const failedSimulationState: SimulationState = {
			success: false,
			simulationStateInput: [{
				stateOverrides: {},
				transactions: [{
					signedTransaction: {
						type: '1559',
						from: 0n,
						nonce: 0n,
						maxFeePerGas: 1n,
						maxPriorityFeePerGas: 1n,
						gas: 21_000n,
						to: ETHEREUM_LOGS_LOGGER_ADDRESS,
						value: 0n,
						input: new Uint8Array(),
						chainId: rpcNetwork.chainId,
						hash: 1n,
						v: 1n,
						r: 1n,
						s: 1n,
					},
					website: { websiteOrigin: 'https://example.com', icon: undefined, title: 'Example' },
					created,
					originalRequestParameters: { method: 'eth_sendTransaction', params: [{ from: 0n, to: ETHEREUM_LOGS_LOGGER_ADDRESS, value: 0n, input: new Uint8Array() }] },
					transactionIdentifier: 1n,
				}],
				signedMessages: [],
				blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 0n, deltaUnit: 'Seconds' },
				simulateWithZeroBaseFee: false,
			}],
			jsonRpcError: { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'simulation failed' } },
			blockNumber: 1n,
			blockTimestamp: created,
			baseFeePerGas: 1n,
			simulationConductedTimestamp: created,
			rpcNetwork,
		}

		await assert.rejects(
			async () => await visualizeSimulatorState(failedSimulationState, ethereum, new TokenPriceService(ethereum, 0), undefined),
			(error) => error === NEW_BLOCK_ABORT,
		)
		assert.equal(await getLatestUnexpectedError(), undefined)
	})
})
