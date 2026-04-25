// @ts-nocheck
import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { ETHEREUM_LOGS_LOGGER_ADDRESS } from '../../app/ts/utils/constants.js'
import { visualizeSimulatorState } from '../../app/ts/background/simulationUpdating.js'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'

function installBrowserMock() {
	const storageState = {}
	globalThis.browser = {
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
	globalThis.chrome = { runtime: { id: 'test-extension' } }
}

async function main() {
	describe('visualizeSimulatorState failed simulations', () => {
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
				clearCache() {},
				async jsonRpcRequest(request) {
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
	})
}


await main()
