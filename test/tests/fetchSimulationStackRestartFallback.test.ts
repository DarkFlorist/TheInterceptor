import * as assert from 'assert'
import { describe, test } from 'bun:test'
import type { FetchSimulationStackRequestConfirmation } from '../../app/ts/types/interceptor-messages.js'
import type { SimulationStackSnapshot } from '../../app/ts/background/windows/fetchSimulationStack.js'
import type { WebsiteTabConnections } from '../../app/ts/types/user-interface-types.js'
import { METAMASK_ERROR_USER_REJECTED_REQUEST } from '../../app/ts/utils/constants.js'

const storageState: Record<string, unknown> = {}
const dialogWindowId = 52
let dialogWindowExists = false

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
				async get() { return undefined },
				async remove() { return undefined },
				onRemoved: { addListener: () => undefined, removeListener: () => undefined },
			},
			windows: {
				async get(id: number) {
					return dialogWindowExists && id === dialogWindowId ? { id } : undefined
				},
				async remove(id: number) {
					if (id === dialogWindowId) dialogWindowExists = false
				},
				onRemoved: { addListener: () => undefined, removeListener: () => undefined },
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

function createConfirmation(accept: boolean): FetchSimulationStackRequestConfirmation {
	return {
		method: 'popup_fetchSimulationStackRequestConfirmation',
		data: { accept, simulationStackVersion: '2.0.0', uniqueRequestIdentifier },
	}
}

// Simulates an MV3 background restart while the dialog is open: the request is persisted in storage and the dialog window exists, but no in-memory waiter remains
async function setUpStoredRequestWithoutPendingWaiter(postedMessages: unknown[]): Promise<WebsiteTabConnections> {
	installBrowserMock()
	for (const key of Object.keys(storageState)) delete storageState[key]
	dialogWindowExists = true
	const { setFetchSimulationStackRequestPromise } = await storageVariablesPromise
	await setFetchSimulationStackRequestPromise({
		website: { websiteOrigin: 'https://requester.example', icon: undefined, title: undefined },
		popupOrTabId: { type: 'popup', id: dialogWindowId },
		simulationOverlayEnabled: true,
		simulationStackVersion: '2.0.0',
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

describe('fetch simulation stack confirmation after a background restart', () => {
	test('rejecting replies with the user-rejected error and does not share the simulation stack', async () => {
		const postedMessages: unknown[] = []
		const websiteTabConnections = await setUpStoredRequestWithoutPendingWaiter(postedMessages)
		const { resolveFetchSimulationStackRequest } = await fetchSimulationStackPromise
		const { getFetchSimulationStackRequestPromise } = await storageVariablesPromise

		await resolveFetchSimulationStackRequest(createSnapshot(), websiteTabConnections, createConfirmation(false))

		const message = getOnlyPostedMessage(postedMessages)
		assert.equal('result' in message, false)
		assert.ok('error' in message && typeof message.error === 'object' && message.error !== null && 'code' in message.error)
		assert.equal(message.error.code, METAMASK_ERROR_USER_REJECTED_REQUEST)
		assert.equal(await getFetchSimulationStackRequestPromise(), undefined)
		assert.equal(dialogWindowExists, false)
	})

	test('accepting replies with the simulation stack', async () => {
		const postedMessages: unknown[] = []
		const websiteTabConnections = await setUpStoredRequestWithoutPendingWaiter(postedMessages)
		const { resolveFetchSimulationStackRequest } = await fetchSimulationStackPromise
		const { getFetchSimulationStackRequestPromise } = await storageVariablesPromise

		await resolveFetchSimulationStackRequest(createSnapshot(), websiteTabConnections, createConfirmation(true))

		const message = getOnlyPostedMessage(postedMessages)
		assert.equal('error' in message, false)
		assert.ok('result' in message && typeof message.result === 'object' && message.result !== null && 'version' in message.result)
		assert.equal(message.result.version, '2.0.0')
		assert.equal(await getFetchSimulationStackRequestPromise(), undefined)
		assert.equal(dialogWindowExists, false)
	})
})
