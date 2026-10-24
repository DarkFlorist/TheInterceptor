import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import type { IEthereumJSONRpcRequestHandler } from '../../app/ts/simulation/services/EthereumJSONRpcRequestHandler.js'
import type { EthereumJsonRpcRequest } from '../../app/ts/types/JsonRpc-types.js'
import type { SimulationState } from '../../app/ts/types/visualizer-types.js'

type StorageKeys = string | readonly string[] | Record<string, unknown> | undefined

const getRequestedStorageKeys = (keys: StorageKeys, storageState: Record<string, unknown>) => {
	if (keys === undefined) return Object.keys(storageState)
	if (typeof keys === 'string') return [keys]
	if (Array.isArray(keys)) return [...keys]
	return Object.keys(keys)
}

// Installs an in-memory browser.storage.local and records every key read, so protector tests can assert which stored values were loaded.
export const installBrowserStorageMock = () => {
	const storageState: Record<string, unknown> = {}
	const readStorageKeys: string[] = []
	const browser = {
		storage: {
			local: {
				async get(keys?: StorageKeys) {
					readStorageKeys.push(...getRequestedStorageKeys(keys, storageState))
					if (keys === undefined) return { ...storageState }
					if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, storageState[key]]))
					if (typeof keys === 'string') return { [keys]: storageState[keys] }
					return Object.fromEntries(Object.entries(keys).map(([key, defaultValue]) => [key, key in storageState ? storageState[key] : defaultValue]))
				},
				async set(items: Record<string, unknown>) {
					Object.assign(storageState, items)
				},
				async remove(keys: string | readonly string[]) {
					for (const key of Array.isArray(keys) ? keys : [keys]) delete storageState[key]
				},
			},
		},
	}
	Reflect.set(globalThis, 'browser', browser)
	Reflect.set(globalThis, 'chrome', { runtime: { id: 'test-extension' } })
	return { readStorageKeys }
}

const mainnetRpcEntry = {
	name: 'Ethereum Mainnet',
	chainId: 1n,
	httpsRpc: 'https://ethereum.dark.florist',
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	primary: true,
	minimized: true,
}

// Every RPC request fails, so tests prove that the protectors under test resolve everything from metadata and storage.
const offlineRequestHandler: IEthereumJSONRpcRequestHandler = {
	rpcUrl: mainnetRpcEntry.httpsRpc,
	clearCache() {
		return undefined
	},
	async getChainId() {
		return mainnetRpcEntry.chainId
	},
	async jsonRpcRequest(request: EthereumJsonRpcRequest) {
		throw new Error(`Unexpected RPC method: ${ request.method }`)
	},
}

export const createOfflineMainnetEthereumClientService = () => new EthereumClientService(offlineRequestHandler, async () => undefined, async () => undefined, mainnetRpcEntry)

export const failedMainnetSimulationState: SimulationState = {
	success: false,
	simulationStateInput: [],
	jsonRpcError: {
		jsonrpc: '2.0',
		id: 1,
		error: {
			code: -32000,
			message: 'simulation unavailable',
		},
	},
	blockNumber: 1n,
	blockTimestamp: new Date('2024-01-01T00:00:00.000Z'),
	baseFeePerGas: 1n,
	simulationConductedTimestamp: new Date('2024-01-01T00:00:00.000Z'),
	rpcNetwork: mainnetRpcEntry,
}
