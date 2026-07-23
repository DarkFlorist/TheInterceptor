import * as assert from 'assert'
import { describe, test } from 'bun:test'
import type { FetchSimulationStackRequestConfirmation } from '../../app/ts/types/interceptor-messages.js'
import type { SimulationStackSnapshot } from '../../app/ts/background/windows/fetchSimulationStack.js'

const storageState: Record<string, unknown> = {}
let popupWindowExists = false

function installBrowserMock() {
	Object.defineProperty(globalThis, 'browser', {
		configurable: true,
		writable: true,
		value: {
			runtime: {
				lastError: null,
				getManifest: () => ({ manifest_version: 3 }),
				getURL: (path: string) => `chrome-extension://test-extension${ path }`,
			},
			storage: {
				local: {
					async get(keys?: string | string[]) {
						const requestedKeys = Array.isArray(keys) ? keys : keys === undefined ? Object.keys(storageState) : [keys]
						return Object.fromEntries(requestedKeys.filter((key) => key in storageState).map((key) => [key, storageState[key]]))
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
				async create() { return undefined },
				async get() { return undefined },
				async remove() { return undefined },
				onRemoved: { addListener: () => undefined, removeListener: () => undefined },
			},
			windows: {
				async create() {
					popupWindowExists = true
					return { id: 41 }
				},
				async get() {
					return popupWindowExists ? { id: 41 } : undefined
				},
				async remove() {
					popupWindowExists = false
				},
				onRemoved: { addListener: () => undefined, removeListener: () => undefined },
			},
		},
	})
}

installBrowserMock()

const modulesPromise = import('../../app/ts/background/windows/fetchSimulationStack.js')

const blockTimeManipulation = { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' } as const
const rpcNetwork = {
	name: 'Test RPC',
	chainId: 1n,
	httpsRpc: 'https://rpc.example',
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	primary: true,
	minimized: false,
} as const

function createSnapshot(balance: bigint): SimulationStackSnapshot {
	const stateOverrides = { '0x0000000000000000000000000000000000000001': { balance } }
	const simulationInput = [{
		stateOverrides,
		transactions: [],
		signedMessages: [],
		blockTimeManipulation,
		simulateWithZeroBaseFee: false,
	}]
	return {
		simulationInput: { kind: 'simulated', value: simulationInput },
		simulationState: {
			kind: 'simulated',
			value: {
				success: true,
				simulationStateInput: simulationInput,
				simulatedBlocks: [{
					stateOverrides,
					simulatedTransactions: [],
					signedMessages: [],
					blockTimestamp: new Date('2026-01-01T00:00:12.000Z'),
					blockTimeManipulation,
					blockBaseFeePerGas: 1n,
				}],
				blockNumber: 1n,
				blockTimestamp: new Date('2026-01-01T00:00:00.000Z'),
				baseFeePerGas: 1n,
				simulationConductedTimestamp: new Date('2026-01-01T00:00:13.000Z'),
				rpcNetwork,
			},
		},
	}
}

describe('fetch simulation stack freshness', () => {
	test('returns and fingerprints the confirmation-time snapshot', async () => {
		for (const key of Object.keys(storageState)) delete storageState[key]
		popupWindowExists = false
		const modules = await modulesPromise
		const initialSnapshot = createSnapshot(1n)
		const confirmationSnapshot = createSnapshot(2n)
		const uniqueRequestIdentifier = { requestId: 7, requestSocket: { tabId: 3, connectionName: 5n } }
		const confirmation: FetchSimulationStackRequestConfirmation = {
			method: 'popup_fetchSimulationStackRequestConfirmation',
			data: {
				accept: true,
				simulationStackVersion: '2.0.0',
				uniqueRequestIdentifier,
			},
		}

		const pendingResult = modules.openFetchSimulationStackDialog(
			initialSnapshot,
			new Map(),
			uniqueRequestIdentifier,
			{ method: 'interceptor_getSimulationStack', params: ['2.0.0'] },
			{ websiteOrigin: 'https://requester.example', icon: undefined, title: undefined },
		)
		await modules.resolveFetchSimulationStackRequest(confirmationSnapshot, new Map(), confirmation)
		const result = await pendingResult

		assert.ok('result' in result)
		assert.deepEqual(result.result.payload.stateOverrides, confirmationSnapshot.simulationInput.value[0]?.stateOverrides)
		assert.equal(result.simulationStackHash, modules.getSimulationStackHash(confirmationSnapshot.simulationInput))
		assert.notEqual(result.simulationStackHash, modules.getSimulationStackHash(initialSnapshot.simulationInput))
	})
})
