import * as assert from 'assert'
import { describe, test } from 'bun:test'

function installBrowserMock() {
	const storageState: Record<string, unknown> = {}
	const browser = {
		runtime: {
			lastError: null,
			async sendMessage() { return undefined },
			getManifest: () => ({ manifest_version: 3 }),
			onMessage: { addListener: () => undefined, removeListener: () => undefined },
			onConnect: { addListener: () => undefined, removeListener: () => undefined },
		},
		storage: {
			local: {
				async get(keys) {
					if (keys === undefined || keys === null) return { ...storageState }
					if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, storageState[key]]))
					if (typeof keys === 'string') return { [keys]: storageState[keys] }
					return Object.fromEntries(Object.entries(keys).map(([key, defaultValue]) => [key, key in storageState ? storageState[key] : defaultValue]))
				},
				async set(items) { Object.assign(storageState, items) },
				async remove(keys) {
					for (const key of Array.isArray(keys) ? keys : [keys]) delete storageState[key]
				},
			},
		},
		tabs: {
			async query() { return [] },
			async get() { return undefined },
			async update() { return undefined },
			onUpdated: { addListener: () => undefined, removeListener: () => undefined },
			onRemoved: { addListener: () => undefined, removeListener: () => undefined },
		},
		windows: {
			async get() { return undefined },
			async update() { return undefined },
		},
		action: {
			async setIcon() { return undefined },
			async setTitle() { return undefined },
			async setBadgeText() { return undefined },
			async setBadgeBackgroundColor() { return undefined },
		},
		browserAction: {
			async setIcon() { return undefined },
			async setTitle() { return undefined },
			async setBadgeText() { return undefined },
			async setBadgeBackgroundColor() { return undefined },
		},
	}
	Object.defineProperty(globalThis, 'browser', { value: browser, configurable: true, writable: true })
	Object.defineProperty(globalThis, 'chrome', { value: { runtime: { id: 'test-extension' } }, configurable: true, writable: true })
}

installBrowserMock()

const { ETHEREUM_LOGS_LOGGER_ADDRESS, NEW_BLOCK_ABORT } = await import('../../app/ts/utils/constants.js')
const { visualizeSimulatorState } = await import('../../app/ts/background/simulationUpdating.js')
const { EthereumClientService } = await import('../../app/ts/simulation/services/EthereumClientService.js')
const { getLatestUnexpectedError } = await import('../../app/ts/background/storageVariables.js')
const { JsonRpcResponseError } = await import('../../app/ts/utils/errors.js')

describe('visualizeSimulatorState failed simulations', () => {
	test('visualizes a successful transaction with fallback address metadata when on-chain token probes fail', async () => {
		installBrowserMock()
		const rpcNetwork = {
			name: 'Test Chain',
			chainId: 1337n,
			httpsRpc: 'https://example.invalid',
			currencyName: 'Ether',
			currencyTicker: 'ETH',
			primary: true,
			minimized: true,
		}
		const baseEthereum = new EthereumClientService({
			rpcUrl: rpcNetwork.httpsRpc,
			clearCache() { return undefined },
			async jsonRpcRequest() { throw new Error('Unexpected direct RPC request') },
		}, async () => undefined, async () => undefined, rpcNetwork)
		const ethereum = new Proxy(baseEthereum, {
			get(target, property, receiver) {
				if (property === 'getCode') return async () => new Uint8Array([1])
				if (property === 'ethSimulateV1') return async () => {
					throw new JsonRpcResponseError({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'intrinsic gas too low' } })
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
			originalRequestParameters: { method: 'eth_sendTransaction' as const, params: [{ from: 0n, to: targetAddress }] },
			transactionIdentifier: 1n,
		}
		const simulationState = {
			success: true as const,
			simulationStateInput: [{
				stateOverrides: {},
				transactions: [transaction],
				signedMessages: [],
				blockTimeManipulation: { type: 'AddToTimestamp' as const, deltaToAdd: 0n, deltaUnit: 'Seconds' as const },
				simulateWithZeroBaseFee: false,
			}],
			simulatedBlocks: [],
			blockNumber: 1n,
			blockTimestamp: created,
			baseFeePerGas: 1n,
			simulationConductedTimestamp: created,
			rpcNetwork,
		}
		const originalConsoleWarn = console.warn
		const originalConsoleError = console.error
		console.warn = () => undefined
		console.error = () => undefined
		let visualized: Awaited<ReturnType<typeof visualizeSimulatorState>>
		try {
			visualized = await visualizeSimulatorState(simulationState, ethereum, { estimateEthereumPricesForTokens: async () => [] }, undefined)
		} finally {
			console.warn = originalConsoleWarn
			console.error = originalConsoleError
		}

		const targetEntry = visualized.addressBookEntries.find((entry) => entry.address === targetAddress)
		assert.equal(targetEntry?.entrySource, 'FilledIn')
		assert.equal(targetEntry?.chainId, rpcNetwork.chainId)
		assert.equal(visualized.visualizedSimulationState.success, true)
	})

	test('keeps fetched address metadata instead of returning an empty address book', async () => {
		installBrowserMock()

		const rpcNetwork = {
			name: 'Test Chain',
			chainId: 1337n,
			httpsRpc: 'https://example.invalid',
			currencyName: 'Ether',
			currencyTicker: 'ETH',
			primary: true,
			minimized: true,
		}

		const ethereum = new EthereumClientService({
			rpcUrl: rpcNetwork.httpsRpc,
			clearCache() { return undefined },
			async jsonRpcRequest(request) {
				if (request.method === 'eth_getCode') return '0x'
				throw new Error(`Unexpected RPC method: ${ request.method }`)
			},
		}, async () => undefined, async () => undefined, rpcNetwork)

		const created = new Date('2024-01-01T00:00:00.000Z')
		const failedSimulationState = {
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

		const visualized = await visualizeSimulatorState(failedSimulationState, ethereum, { estimateEthereumPricesForTokens: async () => [] }, undefined)

		assert.equal(visualized.addressBookEntries.length, 2)
		assert.equal(visualized.addressBookEntries.some((entry) => entry.address === 0n), true)
		assert.equal(visualized.addressBookEntries.some((entry) => entry.address === ETHEREUM_LOGS_LOGGER_ADDRESS), true)
		assert.equal(visualized.visualizedSimulationState.success, false)
		assert.equal(visualized.visualizedSimulationState.visualizedBlocks[0]?.simulatedAndVisualizedTransactions[0]?.transaction.from.address, 0n)
		assert.equal(visualized.visualizedSimulationState.visualizedBlocks[0]?.simulatedAndVisualizedTransactions[0]?.transaction.to?.address, ETHEREUM_LOGS_LOGGER_ADDRESS)
	})

	test('propagates new-block aborts during delegation lookup without recording an unexpected error', async () => {
		installBrowserMock()

		const rpcNetwork = {
			name: 'Test Chain',
			chainId: 1337n,
			httpsRpc: 'https://example.invalid',
			currencyName: 'Ether',
			currencyTicker: 'ETH',
			primary: true,
			minimized: true,
		}

		const ethereum = new EthereumClientService({
			rpcUrl: rpcNetwork.httpsRpc,
			clearCache() { return undefined },
			async jsonRpcRequest(request) {
				if (request.method === 'eth_getCode') throw NEW_BLOCK_ABORT
				throw new Error(`Unexpected RPC method: ${ request.method }`)
			},
		}, async () => undefined, async () => undefined, rpcNetwork)

		const created = new Date('2024-01-01T00:00:00.000Z')
		const failedSimulationState = {
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
			async () => await visualizeSimulatorState(failedSimulationState, ethereum, { estimateEthereumPricesForTokens: async () => [] }, undefined),
			(error) => error === NEW_BLOCK_ABORT,
		)
		assert.equal(await getLatestUnexpectedError(), undefined)
	})
})
