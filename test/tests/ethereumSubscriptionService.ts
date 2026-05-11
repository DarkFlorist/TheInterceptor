import * as assert from 'assert'
import { describe, run, runIfRoot, should } from '../micro-should.js'
import type { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import type { SimulationState } from '../../app/ts/types/visualizer-types.js'

function installBrowserMock() {
	const storageState: Record<string, unknown> = {}
	globalThis.browser = {
		runtime: {
			lastError: null,
			async sendMessage() {
				return undefined
			},
			getManifest: () => ({ manifest_version: 3 }),
			onMessage: { addListener: () => undefined, removeListener: () => undefined },
			onConnect: { addListener: () => undefined, removeListener: () => undefined },
		},
		storage: {
			local: {
				async get(keys?: string | string[] | Record<string, unknown> | null) {
					if (keys === undefined || keys === null) return { ...storageState }
					if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, storageState[key]]))
					if (typeof keys === 'string') return { [keys]: storageState[keys] }
					return Object.fromEntries(Object.entries(keys).map(([key, defaultValue]) => [key, key in storageState ? storageState[key] : defaultValue]))
				},
				async set(items: Record<string, unknown>) {
					Object.assign(storageState, items)
				},
				async remove(keys: string | string[]) {
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
	} as unknown as typeof globalThis.browser
	;(globalThis as typeof globalThis & { chrome: { runtime: { id: string } } }).chrome = { runtime: { id: 'test-extension' } }
	return storageState
}

async function loadModules() {
	return {
		...await import('../../app/ts/background/storageVariables.js'),
		...await import('../../app/ts/simulation/services/EthereumSubscriptionService.js'),
		...await import('../../app/ts/simulation/services/SimulationModeEthereumClientService.js'),
	}
}

const rpcNetwork = {
	name: 'Goerli',
	chainId: 5n,
	httpsRpc: 'https://rpc.dark.florist/flipcardtrustone',
	currencyName: 'Goerli Testnet ETH',
	currencyTicker: 'GÖETH',
	primary: true,
	minimized: true,
	weth: 0xb4fbf271143f4fbf7b91a5ded31805e42b2208d6n,
} as const

export async function main() {
	describe('EthereumSubscriptionService', () => {
		should('removeEthereumSubscription only removes the matching socket subscription', async () => {
			installBrowserMock()
			const { getEthereumSubscriptionsAndFilters, removeEthereumSubscription, updateEthereumSubscriptionsAndFilters } = await loadModules()

			const socket = { tabId: 1, connectionName: 1n } as const
			const otherSocket = { tabId: 2, connectionName: 2n } as const
			await updateEthereumSubscriptionsAndFilters(() => ([
				{ type: 'newHeads', subscriptionOrFilterId: 'remove-me', params: { method: 'eth_subscribe', params: ['newHeads'] }, subscriptionCreatorSocket: socket },
				{ type: 'newHeads', subscriptionOrFilterId: 'keep-same-socket', params: { method: 'eth_subscribe', params: ['newHeads'] }, subscriptionCreatorSocket: socket },
				{ type: 'newHeads', subscriptionOrFilterId: 'keep-other-socket', params: { method: 'eth_subscribe', params: ['newHeads'] }, subscriptionCreatorSocket: otherSocket },
			]))

			assert.equal(await removeEthereumSubscription(socket, 'remove-me'), true)
			assert.deepEqual((await getEthereumSubscriptionsAndFilters()).map((entry) => entry.subscriptionOrFilterId), ['keep-same-socket', 'keep-other-socket'])
		})

		should('getEthFilterChanges applies the real filter payload and preserves the stored subscription list', async () => {
			installBrowserMock()
			const { DEFAULT_BLOCK_MANIPULATION, getEthereumSubscriptionsAndFilters, getEthFilterChanges, mockSignTransaction, updateEthereumSubscriptionsAndFilters } = await loadModules()

			const matchingAddress = 0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeen
			const otherAddress = 0x1111111111111111111111111111111111111111n
			const matchingTopic = 0xabcden
			const filterSocket = { tabId: 1, connectionName: 1n } as const
			const otherSocket = { tabId: 2, connectionName: 2n } as const

			const matchingTransaction = mockSignTransaction({
				type: '1559',
				from: 0xd8da6bf26964af9d7eed9e03e53415d37aa96045n,
				nonce: 0n,
				maxFeePerGas: 1n,
				maxPriorityFeePerGas: 1n,
				gas: 21000n,
				to: 0xda9dfa130df4de4673b89022ee50ff26f6ea73cfn,
				value: 10n,
				input: new Uint8Array(0),
				chainId: 5n,
			})
			const otherTransaction = mockSignTransaction({
				type: '1559',
				from: 0xd8da6bf26964af9d7eed9e03e53415d37aa96045n,
				nonce: 1n,
				maxFeePerGas: 1n,
				maxPriorityFeePerGas: 1n,
				gas: 21000n,
				to: 0xda9dfa130df4de4673b89022ee50ff26f6ea73cfn,
				value: 10n,
				input: new Uint8Array(0),
				chainId: 5n,
			})

			const simulationState: SimulationState = {
				blockNumber: 100n,
				blockTimestamp: new Date(0),
				rpcNetwork,
				baseFeePerGas: 0n,
				simulationConductedTimestamp: new Date(1),
				success: true,
				simulatedBlocks: [{
					simulatedTransactions: [
						{
							realizedGasPrice: 1n,
							preSimulationTransaction: {
								signedTransaction: matchingTransaction,
								website: { websiteOrigin: 'test', icon: undefined, title: undefined },
								created: new Date(0),
								originalRequestParameters: { method: 'eth_sendTransaction', params: [{}] },
								transactionIdentifier: 1n,
							},
							ethSimulateV1CallResult: {
								status: 'success',
								returnData: new Uint8Array(0),
								gasUsed: 21000n,
								logs: [{
									address: matchingAddress,
									data: new Uint8Array(0),
									topics: [matchingTopic],
									logIndex: 0n,
									blockHash: 1n,
									blockNumber: 101n,
									transactionHash: matchingTransaction.hash,
									transactionIndex: 0n,
								}],
							},
							tokenBalancesAfter: [],
						},
						{
							realizedGasPrice: 1n,
							preSimulationTransaction: {
								signedTransaction: otherTransaction,
								website: { websiteOrigin: 'test', icon: undefined, title: undefined },
								created: new Date(0),
								originalRequestParameters: { method: 'eth_sendTransaction', params: [{}] },
								transactionIdentifier: 2n,
							},
							ethSimulateV1CallResult: {
								status: 'success',
								returnData: new Uint8Array(0),
								gasUsed: 21000n,
								logs: [{
									address: otherAddress,
									data: new Uint8Array(0),
									topics: [matchingTopic],
									logIndex: 0n,
									blockHash: 2n,
									blockNumber: 101n,
									transactionHash: otherTransaction.hash,
									transactionIndex: 1n,
								}],
							},
							tokenBalancesAfter: [],
						},
					],
					signedMessages: [],
					stateOverrides: {},
					blockTimestamp: new Date(12_000),
					blockTimeManipulation: DEFAULT_BLOCK_MANIPULATION,
					blockBaseFeePerGas: 0n,
				}],
				simulationStateInput: [],
			}

			await updateEthereumSubscriptionsAndFilters(() => ([
					{
						type: 'eth_newFilter',
						subscriptionOrFilterId: 'filter-1',
						params: { method: 'eth_newFilter', params: [{ address: matchingAddress, topics: [matchingTopic] }] },
						subscriptionCreatorSocket: filterSocket,
						calledInlastBlock: 100n,
					},
					{
						type: 'newHeads',
						subscriptionOrFilterId: 'keep-me',
						params: { method: 'eth_subscribe', params: ['newHeads'] },
						subscriptionCreatorSocket: otherSocket,
					},
				]))

			const ethereumClientService = {
				async getBlockNumber() { return 100n },
				async getLogs() { return [] },
			} as unknown as EthereumClientService

			const firstChanges = await getEthFilterChanges('filter-1', ethereumClientService, undefined, simulationState)
			assert.equal(firstChanges?.length, 1)
			assert.equal(firstChanges?.[0]?.address, matchingAddress)

			const secondChanges = await getEthFilterChanges('filter-1', ethereumClientService, undefined, simulationState)
			assert.deepEqual(secondChanges, [])

			const updated = await getEthereumSubscriptionsAndFilters()
			assert.equal(updated.length, 2)
			assert.equal(updated[0]?.type, 'eth_newFilter')
			if (updated[0]?.type !== 'eth_newFilter') throw new Error('Filter was not preserved')
			assert.equal(updated[0].calledInlastBlock, 101n)
			assert.equal(updated[1]?.subscriptionOrFilterId, 'keep-me')
		})
	})
}

await runIfRoot(async () => {
	await main()
	await run()
}, import.meta)
