import * as assert from 'assert'
import { describe, test } from 'bun:test'
import type { SimulationStackVersion } from '../../app/ts/types/JsonRpc-types.js'
import type { FetchSimulationStackRequestConfirmation } from '../../app/ts/types/interceptor-messages.js'
import type { SimulationStackSnapshot } from '../../app/ts/background/windows/fetchSimulationStack.js'
import type { WebsiteTabConnections } from '../../app/ts/types/user-interface-types.js'
import { METAMASK_ERROR_USER_REJECTED_REQUEST } from '../../app/ts/utils/constants.js'
import { Future } from '../../app/ts/utils/future.js'

const storageState: Record<string, unknown> = {}
const dialogWindowId = 52
const newDialogWindowId = 53
const openWindowIds = new Set<number>()
const windowRemovedListeners = new Set<(id: number) => void>()
let beforeWindowRemoved: ((id: number) => Promise<void>) | undefined
let afterStorageRead: ((requestedKeys: readonly string[]) => Promise<void>) | undefined

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
						const items = Object.fromEntries(requestedKeys.filter((key) => key in storageState).map((key) => [key, storageState[key]]))
						await afterStorageRead?.(requestedKeys)
						return items
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
				async get() { return undefined },
				async remove() { return undefined },
				onRemoved: { addListener: () => undefined, removeListener: () => undefined },
			},
			windows: {
				async create() {
					openWindowIds.add(newDialogWindowId)
					return { id: newDialogWindowId }
				},
				async get(id: number) {
					return openWindowIds.has(id) ? { id } : undefined
				},
				async remove(id: number) {
					await beforeWindowRemoved?.(id)
					openWindowIds.delete(id)
					for (const listener of windowRemovedListeners) listener(id)
				},
				onRemoved: {
					addListener: (listener: (id: number) => void) => { windowRemovedListeners.add(listener) },
					removeListener: (listener: (id: number) => void) => { windowRemovedListeners.delete(listener) },
				},
			},
		},
	})
}

installBrowserMock()

const fetchSimulationStackPromise = import('../../app/ts/background/windows/fetchSimulationStack.js')
const storageVariablesPromise = import('../../app/ts/background/storageVariables.js')
const backgroundUtilsPromise = import('../../app/ts/background/backgroundUtils.js')

const socket = { tabId: 9, connectionName: 17n }
const uniqueRequestIdentifier = { requestId: 30, requestSocket: socket }
const newRequestIdentifier = { requestId: 31, requestSocket: socket }
const stateOverrides = { '0x0000000000000000000000000000000000000001': { balance: 5n } }

function createSnapshot(): SimulationStackSnapshot {
	const blockTimeManipulation = { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' } as const
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
				rpcNetwork: {
					name: 'Test RPC',
					chainId: 1n,
					httpsRpc: 'https://rpc.example',
					currencyName: 'Ether',
					currencyTicker: 'ETH',
					primary: true,
					minimized: false,
				},
			},
		},
	}
}

function createSnapshotWithFailingExtraction(): SimulationStackSnapshot {
	const snapshot = createSnapshot()
	if (snapshot.simulationState.kind !== 'simulated' || !snapshot.simulationState.value.success) throw new Error('Expected a successful simulation snapshot')
	return {
		...snapshot,
		simulationState: {
			kind: 'simulated',
			value: {
				...snapshot.simulationState.value,
				get simulatedBlocks(): never { throw new Error('Injected extraction failure') },
			},
		},
	}
}

function createRecordingPort(postedMessages: unknown[]): browser.runtime.Port {
	const event = {
		addListener() { return undefined },
		removeListener() { return undefined },
		hasListener() { return false },
	}
	return {
		name: 'recording-test-port',
		disconnect() { return undefined },
		postMessage(message: unknown) { postedMessages.push(message) },
		onMessage: event,
		onDisconnect: event,
	}
}

function createConfirmation(accept: boolean, confirmedRequestIdentifier = uniqueRequestIdentifier): FetchSimulationStackRequestConfirmation {
	return {
		method: 'popup_fetchSimulationStackRequestConfirmation',
		data: { accept, simulationStackVersion: '2.0.0', uniqueRequestIdentifier: confirmedRequestIdentifier },
	}
}

// Simulates an MV3 background restart while the dialog is open: the request is persisted in storage and the dialog window exists, but no in-memory waiter remains
async function setUpStoredRequestWithoutPendingWaiter(postedMessages: unknown[], simulationStackVersion: SimulationStackVersion = '2.0.0'): Promise<WebsiteTabConnections> {
	installBrowserMock()
	for (const key of Object.keys(storageState)) delete storageState[key]
	openWindowIds.clear()
	windowRemovedListeners.clear()
	beforeWindowRemoved = undefined
	afterStorageRead = undefined
	openWindowIds.add(dialogWindowId)
	const { setFetchSimulationStackRequestPromise } = await storageVariablesPromise
	await setFetchSimulationStackRequestPromise({
		website: { websiteOrigin: 'https://requester.example', icon: undefined, title: undefined },
		popupOrTabId: { type: 'popup', id: dialogWindowId },
		simulationOverlayEnabled: true,
		simulationStackVersion,
		uniqueRequestIdentifier,
	})
	const { websiteSocketToString } = await backgroundUtilsPromise
	return new Map([[socket.tabId, { connections: {
		[websiteSocketToString(socket)]: {
			port: createRecordingPort(postedMessages),
			socket,
			websiteOrigin: 'https://requester.example',
			approved: true,
			wantsToConnect: true,
		},
	} }]])
}

function getOnlyPostedMessage(postedMessages: unknown[]) {
	assert.equal(postedMessages.length, 1)
	const [message] = postedMessages
	if (typeof message !== 'object' || message === null) throw new Error('Expected the website to receive a reply object')
	return message
}

async function openNewRequest() {
	const { openFetchSimulationStackDialog } = await fetchSimulationStackPromise
	return openFetchSimulationStackDialog(createSnapshot(), true, new Map(), newRequestIdentifier, { method: 'interceptor_getSimulationStack', params: ['2.0.0'] }, { websiteOrigin: 'https://requester.example', icon: undefined, title: undefined })
}

async function waitForNewRequestToBeStoredOrSettled(newRequest: Promise<unknown>) {
	const { getFetchSimulationStackRequestPromise } = await storageVariablesPromise
	let newRequestSettled = false
	newRequest.finally(() => { newRequestSettled = true })
	while (!newRequestSettled && (await getFetchSimulationStackRequestPromise())?.popupOrTabId.id !== newDialogWindowId) await new Promise((resolve) => setTimeout(resolve, 0))
}

// Keeps the old dialog open until a new request has been handled, so the request arrives while the resolution is closing the dialog
function startNewRequestWhenOldDialogCloses() {
	let newRequest: ReturnType<typeof openNewRequest> | undefined
	beforeWindowRemoved = async (id: number) => {
		if (id !== dialogWindowId || newRequest !== undefined) return
		newRequest = openNewRequest()
		await waitForNewRequestToBeStoredOrSettled(newRequest)
	}
	return () => {
		if (newRequest === undefined) throw new Error('Expected a new request to open its dialog while the old dialog was closing')
		return newRequest
	}
}

// Holds back the result of the first storage read of the given key, so the reader acts on what it read only after the returned release function is called
function pauseAfterStorageReadOf(key: string) {
	const paused = new Future<void>()
	const released = new Future<void>()
	afterStorageRead = async (requestedKeys) => {
		if (!requestedKeys.includes(key)) return
		afterStorageRead = undefined
		paused.resolve()
		await released
	}
	return { paused, release: () => released.resolve() }
}

function assertUserRejectedReply(message: object) {
	assert.equal('result' in message, false)
	if (!('error' in message) || typeof message.error !== 'object' || message.error === null || !('code' in message.error)) throw new Error('Expected the website to receive an error reply')
	assert.equal(message.error.code, METAMASK_ERROR_USER_REJECTED_REQUEST)
}

function assertSimulationStackReply(message: object, simulationStackVersion: SimulationStackVersion = '2.0.0') {
	assert.equal('error' in message, false)
	if (!('result' in message) || typeof message.result !== 'object' || message.result === null || !('version' in message.result)) throw new Error('Expected the website to receive the simulation stack')
	assert.equal(message.result.version, simulationStackVersion)
}

describe('fetch simulation stack confirmation after a background restart', () => {
	test('rejecting replies with the user-rejected error and does not share the simulation stack', async () => {
		const postedMessages: unknown[] = []
		const websiteTabConnections = await setUpStoredRequestWithoutPendingWaiter(postedMessages)
		const { resolveFetchSimulationStackRequest } = await fetchSimulationStackPromise
		const { getFetchSimulationStackRequestPromise } = await storageVariablesPromise

		await resolveFetchSimulationStackRequest(createSnapshot(), websiteTabConnections, createConfirmation(false))

		assertUserRejectedReply(getOnlyPostedMessage(postedMessages))
		assert.equal(await getFetchSimulationStackRequestPromise(), undefined)
		assert.equal(openWindowIds.has(dialogWindowId), false)
	})

	test('accepting replies with the simulation stack', async () => {
		const postedMessages: unknown[] = []
		const websiteTabConnections = await setUpStoredRequestWithoutPendingWaiter(postedMessages)
		const { resolveFetchSimulationStackRequest } = await fetchSimulationStackPromise
		const { getFetchSimulationStackRequestPromise } = await storageVariablesPromise

		await resolveFetchSimulationStackRequest(createSnapshot(), websiteTabConnections, createConfirmation(true))

		assertSimulationStackReply(getOnlyPostedMessage(postedMessages))
		assert.equal(await getFetchSimulationStackRequestPromise(), undefined)
		assert.equal(openWindowIds.has(dialogWindowId), false)
	})

	test('a dialog opened while the restarted request closes its dialog can still be closed to reject its own request', async () => {
		const postedMessages: unknown[] = []
		const websiteTabConnections = await setUpStoredRequestWithoutPendingWaiter(postedMessages)
		const { resolveFetchSimulationStackRequest } = await fetchSimulationStackPromise
		const getNewRequest = startNewRequestWhenOldDialogCloses()

		await resolveFetchSimulationStackRequest(createSnapshot(), websiteTabConnections, createConfirmation(false))
		const newRequest = getNewRequest()
		assert.equal(openWindowIds.has(newDialogWindowId), true)

		await browser.windows.remove(newDialogWindowId)
		const newRequestResult = await Promise.race([newRequest, new Promise<'unresolved'>((resolve) => setTimeout(() => resolve('unresolved'), 200))])
		if (newRequestResult === 'unresolved') throw new Error('Closing the new dialog did not resolve its request')
		assert.equal(newRequestResult.outcome, 'rejected')
	})

	test('a request stored while the old dialog closes stays stored', async () => {
		const postedMessages: unknown[] = []
		const websiteTabConnections = await setUpStoredRequestWithoutPendingWaiter(postedMessages)
		const { resolveFetchSimulationStackRequest } = await fetchSimulationStackPromise
		const { getFetchSimulationStackRequestPromise } = await storageVariablesPromise
		const getNewRequest = startNewRequestWhenOldDialogCloses()

		await resolveFetchSimulationStackRequest(createSnapshot(), websiteTabConnections, createConfirmation(false))

		assert.equal((await getFetchSimulationStackRequestPromise())?.uniqueRequestIdentifier.requestId, newRequestIdentifier.requestId)

		await browser.windows.remove(newDialogWindowId)
		await getNewRequest()
	})

	test('concurrent confirmations answer the website once, with the first decision', async () => {
		const postedMessages: unknown[] = []
		const websiteTabConnections = await setUpStoredRequestWithoutPendingWaiter(postedMessages)
		const { resolveFetchSimulationStackRequest } = await fetchSimulationStackPromise
		const { getFetchSimulationStackRequestPromise } = await storageVariablesPromise

		await Promise.all([
			resolveFetchSimulationStackRequest(createSnapshot(), websiteTabConnections, createConfirmation(false)),
			resolveFetchSimulationStackRequest(createSnapshot(), websiteTabConnections, createConfirmation(true)),
		])

		assertUserRejectedReply(getOnlyPostedMessage(postedMessages))
		assert.equal(await getFetchSimulationStackRequestPromise(), undefined)
		assert.equal(openWindowIds.has(dialogWindowId), false)
	})

	test('a failed stack extraction keeps the request retryable and a successful retry replies once', async () => {
		const postedMessages: unknown[] = []
		const websiteTabConnections = await setUpStoredRequestWithoutPendingWaiter(postedMessages)
		const { resolveFetchSimulationStackRequest } = await fetchSimulationStackPromise
		const { getFetchSimulationStackRequestPromise } = await storageVariablesPromise

		await assert.rejects(resolveFetchSimulationStackRequest(createSnapshotWithFailingExtraction(), websiteTabConnections, createConfirmation(true)), /Injected extraction failure/)

		assert.equal(postedMessages.length, 0)
		assert.equal((await getFetchSimulationStackRequestPromise())?.uniqueRequestIdentifier.requestId, uniqueRequestIdentifier.requestId)
		assert.equal(openWindowIds.has(dialogWindowId), true)

		await resolveFetchSimulationStackRequest(createSnapshot(), websiteTabConnections, createConfirmation(true))

		assertSimulationStackReply(getOnlyPostedMessage(postedMessages))
		assert.equal(await getFetchSimulationStackRequestPromise(), undefined)
		assert.equal(openWindowIds.has(dialogWindowId), false)
	})

	test('a request stored while legacy extraction waits on settings survives and the old website still gets one reply', async () => {
		const postedMessages: unknown[] = []
		const websiteTabConnections = await setUpStoredRequestWithoutPendingWaiter(postedMessages, '1.0.0')
		const { resolveFetchSimulationStackRequest } = await fetchSimulationStackPromise
		const { getFetchSimulationStackRequestPromise } = await storageVariablesPromise
		const settingsRead = pauseAfterStorageReadOf('simulationMode')

		const oldResolution = resolveFetchSimulationStackRequest(createSnapshot(), websiteTabConnections, createConfirmation(true))
		await settingsRead.paused
		await browser.windows.remove(dialogWindowId)
		const newRequest = openNewRequest()
		await waitForNewRequestToBeStoredOrSettled(newRequest)
		settingsRead.release()
		await oldResolution

		assertSimulationStackReply(getOnlyPostedMessage(postedMessages), '1.0.0')
		assert.equal((await getFetchSimulationStackRequestPromise())?.uniqueRequestIdentifier.requestId, newRequestIdentifier.requestId)
		assert.equal(openWindowIds.has(newDialogWindowId), true)

		await resolveFetchSimulationStackRequest(createSnapshot(), new Map(), createConfirmation(true, newRequestIdentifier))
		assert.equal((await newRequest).outcome, 'accepted')
		assert.equal(await getFetchSimulationStackRequestPromise(), undefined)
		await browser.windows.remove(newDialogWindowId)
	})

	test('a request stored during a compare-and-clear is not wiped by it', async () => {
		await setUpStoredRequestWithoutPendingWaiter([])
		const { clearFetchSimulationStackRequestPromiseIfOwnedBy, getFetchSimulationStackRequestPromise, setFetchSimulationStackRequestPromise } = await storageVariablesPromise
		const slotRead = pauseAfterStorageReadOf('fetchSimulationStackRequestPromise')

		const clear = clearFetchSimulationStackRequestPromiseIfOwnedBy(uniqueRequestIdentifier)
		await slotRead.paused
		const store = setFetchSimulationStackRequestPromise({
			website: { websiteOrigin: 'https://requester.example', icon: undefined, title: undefined },
			popupOrTabId: { type: 'popup', id: newDialogWindowId },
			simulationOverlayEnabled: true,
			simulationStackVersion: '2.0.0',
			uniqueRequestIdentifier: newRequestIdentifier,
		})
		await new Promise((resolve) => setTimeout(resolve, 0))
		slotRead.release()
		await Promise.all([clear, store])

		assert.equal((await getFetchSimulationStackRequestPromise())?.uniqueRequestIdentifier.requestId, newRequestIdentifier.requestId)
	})
})
