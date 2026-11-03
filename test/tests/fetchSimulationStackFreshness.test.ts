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
	test('keeps a simulation stack request stored before the mode travelled with the request resolvable', async () => {
		for (const key of Object.keys(storageState)) delete storageState[key]
		const storage = await import('../../app/ts/background/storageVariables.js')
		const modules = await modulesPromise
		// A complete request written by the previous version, which only lacks `simulationMode`, as if the background restarted after the upgrade.
		const uniqueRequestIdentifier = { requestId: 1, requestSocket: { tabId: 3, connectionName: 5n } }
		storageState.fetchSimulationStackRequestPromise = { website: { websiteOrigin: 'https://requester.example', icon: undefined, title: undefined }, popupOrTabId: { type: 'popup', id: 1 }, simulationOverlayEnabled: true, simulationStackVersion: '2.0.0', uniqueRequestIdentifier: { requestId: 1, requestSocket: { tabId: 3, connectionName: '0x5' } } }
		const storedRequest = await storage.getFetchSimulationStackRequestPromise()
		assert.ok(storedRequest !== undefined)
		// The mode cannot be recovered, so the page shows the neutral appearance; the request itself and its id are kept.
		assert.equal(storedRequest.simulationMode, undefined)
		assert.deepEqual(storedRequest.uniqueRequestIdentifier, uniqueRequestIdentifier)
		const repliesToWebsite: unknown[] = []
		const port = { postMessage: (message: unknown) => { repliesToWebsite.push(message) } }
		const websiteTabConnections = new Map([[3, { connections: { '3-0x5': { port, socket: uniqueRequestIdentifier.requestSocket, websiteOrigin: 'https://requester.example', approved: true, wantsToConnect: false } } }]])
		await modules.resolveFetchSimulationStackRequest(createSnapshot(1n), websiteTabConnections, {
			method: 'popup_fetchSimulationStackRequestConfirmation',
			data: { uniqueRequestIdentifier, accept: true, simulationStackVersion: '2.0.0' },
		})
		assert.equal(repliesToWebsite.length, 1)
		assert.equal(typeof repliesToWebsite[0] === 'object' && repliesToWebsite[0] !== null && 'requestId' in repliesToWebsite[0] && repliesToWebsite[0].requestId, 1)
		assert.equal(typeof repliesToWebsite[0] === 'object' && repliesToWebsite[0] !== null && 'type' in repliesToWebsite[0] && repliesToWebsite[0].type, 'result')
		await storage.setFetchSimulationStackRequestPromise(undefined)
	})

	test('keeps a watch asset request queued before the mode travelled with the request resolvable', async () => {
		for (const key of Object.keys(storageState)) delete storageState[key]
		const storage = await import('../../app/ts/background/storageVariables.js')
		const { resolveWatchAsset } = await import('../../app/ts/background/windows/watchAsset.js')
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
		// The same complete record as the previous version wrote it, which only lacks `simulationMode`, as if the background restarted after the upgrade.
		const { simulationMode: _droppedSimulationMode, ...previousVersionRecord } = currentVersionRecord
		storageState.pendingWatchAssetRequests = [previousVersionRecord]
		const [storedRequest] = await storage.getPendingWatchAssetRequests()
		assert.ok(storedRequest !== undefined)
		assert.equal(storedRequest.simulationMode, undefined)
		assert.deepEqual(storedRequest.request.uniqueRequestIdentifier, uniqueRequestIdentifier)
		let addedToAddressBook: unknown
		let closedPopupId: number | undefined
		await resolveWatchAsset(new Map(), { method: 'popup_watchAssetDialog', data: { action: 'add', uniqueRequestIdentifier } }, {
			getRequests: storage.getPendingWatchAssetRequests,
			updateRequests: storage.updatePendingWatchAssetRequests,
			updateAddressBook: async (update) => { addedToAddressBook = update([]) },
			publishAddressBookChanged: async () => undefined,
			publish: async () => undefined,
			closeDialog: async (popupOrTabId) => { closedPopupId = popupOrTabId.id },
			processQueue: async () => undefined,
			sendToSigner: () => false,
		})
		assert.deepEqual(addedToAddressBook, [token])
		assert.equal(closedPopupId, 91)
		assert.deepEqual(storageState.pendingWatchAssetRequests, [])
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
			false,
			true,
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

		const firstRequest = modules.openFetchSimulationStackDialogOrGetCachedResult(initialSnapshot, true, true, new Map(), params, website, createRequest(20), socket)
		await modules.resolveFetchSimulationStackRequest(confirmationSnapshot, new Map(), reject(20))
		const firstResult = await firstRequest
		assert.ok('error' in firstResult)
		assert.equal(popupWindowCreationCount, 1)

		const cachedConfirmationResult = await modules.openFetchSimulationStackDialogOrGetCachedResult(confirmationSnapshot, true, true, new Map(), params, website, createRequest(21), socket)
		assert.ok('error' in cachedConfirmationResult)
		assert.equal(popupWindowCreationCount, 1)

		const initialSnapshotRequest = modules.openFetchSimulationStackDialogOrGetCachedResult(initialSnapshot, true, true, new Map(), params, website, createRequest(22), socket)
		await modules.resolveFetchSimulationStackRequest(initialSnapshot, new Map(), reject(22))
		await initialSnapshotRequest
		assert.equal(popupWindowCreationCount, 2)
	})
})
