import * as assert from 'assert'
import { describe, test } from 'bun:test'
import type { FetchSimulationStackRequestConfirmation } from '../../app/ts/types/interceptor-messages.js'
import type { SimulationStackSnapshot } from '../../app/ts/background/windows/fetchSimulationStack.js'

const storageState: Record<string, unknown> = {}
let popupWindowExists = false
let popupWindowCreationCount = 0

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
					popupWindowCreationCount += 1
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
	// A request stored by a version before the request carried its mode has no mode to show. An extension update closes its dialog and disconnects the page that made it, so it could not be answered anyway; it is dropped like any record that no longer decodes, and the live request model keeps its mode required.
	test('drops simulation stack and watch asset requests stored before the request carried its mode', async () => {
		for (const key of Object.keys(storageState)) delete storageState[key]
		const storage = await import('../../app/ts/background/storageVariables.js')
		const { StoredWatchAssetRequest } = await import('../../app/ts/types/user-interface-types.js')
		const token = { type: 'ERC20', name: 'Token', symbol: 'TKN', decimals: 6n, address: 0x1111111111111111111111111111111111111111n, chainId: 1n, entrySource: 'User' } as const
		const uniqueRequestIdentifier = { requestId: 8, requestSocket: { tabId: 2, connectionName: 3n } }
		const currentVersionRecord = StoredWatchAssetRequest.serialize({
			website: { websiteOrigin: 'https://requester.example', icon: undefined, title: undefined },
			simulationMode: true,
			popupOrTabId: { type: 'popup', id: 91 },
			request: { method: 'wallet_watchAsset', params: [{ type: 'ERC20', options: { address: '0x1111111111111111111111111111111111111111', chainId: 1 } }], interceptorRequest: true, usingInterceptorWithoutSigner: false, uniqueRequestIdentifier },
			requestedAsset: { type: 'ERC20', options: { address: token.address, chainId: 1 } },
			currentToken: token,
			token,
			proposedImageUrl: undefined,
			selectedImageUri: undefined,
			imageDownloadError: undefined,
			forwardToSigner: undefined,
			forwardingStatus: undefined,
		})
		// The same complete records as the previous version wrote them, which only lack `simulationMode`.
		const { simulationMode: _droppedSimulationMode, ...previousVersionRecord } = currentVersionRecord
		storageState.pendingWatchAssetRequests = [previousVersionRecord]
		storageState.fetchSimulationStackRequestPromise = { website: { websiteOrigin: 'https://requester.example', icon: undefined, title: undefined }, popupOrTabId: { type: 'popup', id: 1 }, simulationOverlayEnabled: true, simulationStackVersion: '2.0.0', uniqueRequestIdentifier: { requestId: 1, requestSocket: { tabId: 3, connectionName: '0x5' } } }
		const originalWarn = console.warn
		console.warn = () => undefined
		try {
			assert.deepEqual(await storage.getPendingWatchAssetRequests(), [])
			assert.equal(await storage.getFetchSimulationStackRequestPromise(), undefined)
		} finally {
			console.warn = originalWarn
		}
	})

	test('treats requests that no longer decode as absent instead of failing every later request', async () => {
		for (const key of Object.keys(storageState)) delete storageState[key]
		const storage = await import('../../app/ts/background/storageVariables.js')
		storageState.fetchSimulationStackRequestPromise = { website: { websiteOrigin: 'https://requester.example', icon: undefined, title: undefined }, simulationStackVersion: '2.0.0' }
		storageState.pendingWatchAssetRequests = [{ website: { websiteOrigin: 'https://requester.example', icon: undefined, title: undefined } }]
		// Recovery reports each undecodable record with a warning; they are collected here so the long validation messages stay out of the test output.
		const originalWarn = console.warn
		const warnings: unknown[] = []
		console.warn = (...messages: unknown[]) => { warnings.push(...messages) }
		try {
			assert.equal(await storage.getFetchSimulationStackRequestPromise(), undefined)
			assert.deepEqual(await storage.getPendingWatchAssetRequests(), [])
			// The next write replaces the undecodable record.
			assert.deepEqual(await storage.updatePendingWatchAssetRequests((requests) => requests), [])
			assert.deepEqual(storageState.pendingWatchAssetRequests, [])
			await storage.setFetchSimulationStackRequestPromise(undefined)
			assert.equal('fetchSimulationStackRequestPromise' in storageState, false)
		} finally {
			console.warn = originalWarn
		}
		assert.equal(warnings.includes('Simulation stack request was corrupt:'), true)
		assert.equal(warnings.includes('Pending watch asset requests was corrupt:'), true)
	})

	test('propagates a failing storage read instead of writing an empty request queue', async () => {
		for (const key of Object.keys(storageState)) delete storageState[key]
		const storage = await import('../../app/ts/background/storageVariables.js')
		const queuedRecord = { stays: 'untouched' }
		storageState.pendingWatchAssetRequests = [queuedRecord]
		const localStorage = Reflect.get(globalThis, 'browser').storage.local
		const originalGet = localStorage.get
		const originalSet = localStorage.set
		const writes: unknown[] = []
		localStorage.get = async () => { throw new Error('storage read failed') }
		localStorage.set = async (items: Record<string, unknown>) => { writes.push(items) }
		try {
			await assert.rejects(storage.updatePendingWatchAssetRequests((requests) => requests), /storage read failed/)
			await assert.rejects(storage.getPendingWatchAssetRequests(), /storage read failed/)
			await assert.rejects(storage.getFetchSimulationStackRequestPromise(), /storage read failed/)
		} finally {
			localStorage.get = originalGet
			localStorage.set = originalSet
		}
		assert.deepEqual(writes, [])
		assert.deepEqual(storageState.pendingWatchAssetRequests, [queuedRecord])
	})

	test('returns and fingerprints the confirmation-time snapshot', async () => {
		for (const key of Object.keys(storageState)) delete storageState[key]
		popupWindowExists = false
		popupWindowCreationCount = 0
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

		// Safe signing shows the overlay while the Interceptor is signing for real, so the dialog must be told the mode separately.
		const pendingResult = modules.openFetchSimulationStackDialog(
			initialSnapshot,
			{ simulationMode: false, simulationOverlayEnabled: true },
			new Map(),
			uniqueRequestIdentifier,
			{ method: 'interceptor_getSimulationStack', params: ['2.0.0'] },
			{ websiteOrigin: 'https://requester.example', icon: undefined, title: undefined },
		)
		await new Promise((resolve) => setTimeout(resolve, 0))
		const storedRequest = storageState.fetchSimulationStackRequestPromise
		assert.equal(typeof storedRequest === 'object' && storedRequest !== null && 'simulationOverlayEnabled' in storedRequest && storedRequest.simulationOverlayEnabled, true)
		assert.equal(typeof storedRequest === 'object' && storedRequest !== null && 'simulationMode' in storedRequest && storedRequest.simulationMode, false)
		await modules.resolveFetchSimulationStackRequest(confirmationSnapshot, new Map(), confirmation)
		const result = await pendingResult

		assert.equal(result.outcome, 'accepted')
		assert.deepEqual(result.result.payload.stateOverrides, confirmationSnapshot.simulationInput.value[0]?.stateOverrides)
		assert.equal(result.simulationStackHash, modules.getSimulationStackHash(confirmationSnapshot.simulationInput))
		assert.notEqual(result.simulationStackHash, modules.getSimulationStackHash(initialSnapshot.simulationInput))
	})

	test('caches rejection for the confirmation-time snapshot only', async () => {
		for (const key of Object.keys(storageState)) delete storageState[key]
		popupWindowExists = false
		popupWindowCreationCount = 0
		const modules = await modulesPromise
		const initialSnapshot = createSnapshot(3n)
		const confirmationSnapshot = createSnapshot(4n)
		const socket = { tabId: 8, connectionName: 13n }
		const website = { websiteOrigin: 'https://requester.example', icon: undefined, title: undefined }
		const params = { method: 'interceptor_getSimulationStack' as const, params: ['2.0.0' as const] }
		const createRequest = (requestId: number) => ({ method: params.method, params: params.params, uniqueRequestIdentifier: { requestId, requestSocket: socket } })
		const reject = (requestId: number): FetchSimulationStackRequestConfirmation => ({
			method: 'popup_fetchSimulationStackRequestConfirmation',
			data: {
				accept: false,
				simulationStackVersion: '2.0.0',
				uniqueRequestIdentifier: { requestId, requestSocket: socket },
			},
		})

		const firstRequest = modules.openFetchSimulationStackDialogOrGetCachedResult(initialSnapshot, { simulationMode: true, simulationOverlayEnabled: true }, new Map(), params, website, createRequest(20), socket)
		await modules.resolveFetchSimulationStackRequest(confirmationSnapshot, new Map(), reject(20))
		const firstResult = await firstRequest
		assert.ok('error' in firstResult)
		assert.equal(popupWindowCreationCount, 1)

		const cachedConfirmationResult = await modules.openFetchSimulationStackDialogOrGetCachedResult(confirmationSnapshot, { simulationMode: true, simulationOverlayEnabled: true }, new Map(), params, website, createRequest(21), socket)
		assert.ok('error' in cachedConfirmationResult)
		assert.equal(popupWindowCreationCount, 1)

		const initialSnapshotRequest = modules.openFetchSimulationStackDialogOrGetCachedResult(initialSnapshot, { simulationMode: true, simulationOverlayEnabled: true }, new Map(), params, website, createRequest(22), socket)
		await modules.resolveFetchSimulationStackRequest(initialSnapshot, new Map(), reject(22))
		await initialSnapshotRequest
		assert.equal(popupWindowCreationCount, 2)
	})
})
