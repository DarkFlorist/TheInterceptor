import * as assert from 'assert'
import { describe, test } from 'bun:test'
import type { ChainChangeConfirmation, FetchSimulationStackRequestConfirmation } from '../../app/ts/types/interceptor-messages.js'
import type { RpcNetwork } from '../../app/ts/types/rpc.js'
import type { InterceptedRequest, UniqueRequestIdentifier } from '../../app/ts/utils/requests.js'
import type { SimulationStackSnapshot } from '../../app/ts/background/windows/fetchSimulationStack.js'
import { createSimulationServicesOwner } from '../../app/ts/simulation/serviceLifecycle.js'

const storageState: Record<string, unknown> = {}
const openWindows = new Set<number>()
let nextWindowId = 40

function installBrowserMock() {
	Object.defineProperty(globalThis, 'browser', {
		configurable: true,
		writable: true,
		value: {
			runtime: {
				lastError: null,
				getManifest: () => ({ manifest_version: 3 }),
				getURL: (path: string) => `chrome-extension://test-extension${ path }`,
				sendMessage: async () => undefined,
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
					nextWindowId += 1
					openWindows.add(nextWindowId)
					return { id: nextWindowId }
				},
				async get(id: number) {
					return openWindows.has(id) ? { id } : undefined
				},
				async remove(id: number) {
					openWindows.delete(id)
				},
				onRemoved: { addListener: () => undefined, removeListener: () => undefined },
			},
		},
	})
}

installBrowserMock()

const fetchModulesPromise = import('../../app/ts/background/windows/fetchSimulationStack.js')
const chainModulesPromise = import('../../app/ts/background/windows/changeChain.js')

const website = { websiteOrigin: 'https://requester.example', icon: undefined, title: undefined }
const oldIdentifier: UniqueRequestIdentifier = { requestId: 7, requestSocket: { tabId: 3, connectionName: 5n } }
const newIdentifier: UniqueRequestIdentifier = { requestId: 8, requestSocket: { tabId: 4, connectionName: 6n } }
const passthroughSnapshot: SimulationStackSnapshot = { simulationInput: { kind: 'passthrough' }, simulationState: { kind: 'passthrough' } }
const requestedNetwork: RpcNetwork = {
	name: 'Requested RPC',
	chainId: 2n,
	httpsRpc: 'https://requested.example',
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	primary: true,
	minimized: false,
}

function resetDialogEnvironment() {
	for (const key of Object.keys(storageState)) delete storageState[key]
	openWindows.clear()
}

const waitForCondition = async (condition: () => boolean | Promise<boolean>) => {
	const deadline = Date.now() + 1000
	while (!await condition()) {
		if (Date.now() > deadline) throw new Error('Timed out waiting for the dialog')
		await new Promise((resolve) => setTimeout(resolve, 0))
	}
}

const isStillWaiting = async (dialogResult: Promise<unknown>) => await Promise.race([
	dialogResult.then(() => false, () => false),
	new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 20)),
])

describe('fetch simulation stack dialog late confirmations', () => {
	const fetchConfirmation = (uniqueRequestIdentifier: UniqueRequestIdentifier, accept: boolean): FetchSimulationStackRequestConfirmation => ({
		method: 'popup_fetchSimulationStackRequestConfirmation',
		data: { accept, simulationStackVersion: '2.0.0', uniqueRequestIdentifier },
	})

	const openRejectedDialogThenNewDialog = async () => {
		const modules = await fetchModulesPromise
		const openDialog = (uniqueRequestIdentifier: UniqueRequestIdentifier) => modules.openFetchSimulationStackDialog(passthroughSnapshot, false, new Map(), uniqueRequestIdentifier, { method: 'interceptor_getSimulationStack', params: ['2.0.0'] }, website)
		const oldDialog = openDialog(oldIdentifier)
		await waitForCondition(() => openWindows.size === 1)
		await modules.resolveFetchSimulationStackRequest(passthroughSnapshot, new Map(), fetchConfirmation(oldIdentifier, false))
		assert.equal((await oldDialog).outcome, 'rejected')
		const newDialog = openDialog(newIdentifier)
		await waitForCondition(() => 'fetchSimulationStackRequestPromise' in storageState)
		return { modules, newDialog }
	}

	for (const accept of [true, false]) test(`a late ${ accept ? 'accept' : 'reject' } for the old request leaves the new request waiting`, async () => {
		resetDialogEnvironment()
		const { modules, newDialog } = await openRejectedDialogThenNewDialog()

		await modules.resolveFetchSimulationStackRequest(passthroughSnapshot, new Map(), fetchConfirmation(oldIdentifier, accept))

		assert.equal(await isStillWaiting(newDialog), true)
		await modules.resolveFetchSimulationStackRequest(passthroughSnapshot, new Map(), fetchConfirmation(newIdentifier, false))
		assert.equal((await newDialog).outcome, 'rejected')
	})

	test('the new request still takes its own accept after a late confirmation', async () => {
		resetDialogEnvironment()
		const { modules, newDialog } = await openRejectedDialogThenNewDialog()

		await modules.resolveFetchSimulationStackRequest(passthroughSnapshot, new Map(), fetchConfirmation(oldIdentifier, false))
		await modules.resolveFetchSimulationStackRequest(passthroughSnapshot, new Map(), fetchConfirmation(newIdentifier, true))

		assert.equal((await newDialog).outcome, 'accepted')
	})
})

describe('change chain dialog late confirmations', () => {
	const simulationServicesOwner = createSimulationServicesOwner(requestedNetwork, async () => undefined, async (_ethereum, error) => { throw error })
	const chainConfirmation = (uniqueRequestIdentifier: UniqueRequestIdentifier, accept: boolean): ChainChangeConfirmation => ({
		method: 'popup_changeChainDialog',
		data: { rpcNetwork: requestedNetwork, uniqueRequestIdentifier, accept },
	})
	const chainRequest = (uniqueRequestIdentifier: UniqueRequestIdentifier): InterceptedRequest => ({
		interceptorRequest: true,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier,
		method: 'wallet_switchEthereumChain',
		params: [{ chainId: '0x2' }],
	})

	const openRejectedDialogThenNewDialog = async () => {
		const modules = await chainModulesPromise
		const openDialog = (uniqueRequestIdentifier: UniqueRequestIdentifier) => modules.openChangeChainDialog(simulationServicesOwner, new Map(), chainRequest(uniqueRequestIdentifier), true, website, { method: 'wallet_switchEthereumChain', params: [{ chainId: requestedNetwork.chainId }] })
		const oldDialog = openDialog(oldIdentifier)
		await waitForCondition(() => 'chainChangeConfirmationPromise' in storageState)
		await modules.resolveChainChange(simulationServicesOwner, new Map(), chainConfirmation(oldIdentifier, false))
		assert.equal((await oldDialog).error?.code, 4001)
		const newDialog = openDialog(newIdentifier)
		await waitForCondition(() => 'chainChangeConfirmationPromise' in storageState)
		return { modules, newDialog }
	}

	for (const accept of [true, false]) test(`a late ${ accept ? 'accept' : 'reject' } for the old request leaves the new request waiting`, async () => {
		resetDialogEnvironment()
		const { modules, newDialog } = await openRejectedDialogThenNewDialog()

		await modules.resolveChainChange(simulationServicesOwner, new Map(), chainConfirmation(oldIdentifier, accept))

		assert.equal(await isStillWaiting(newDialog), true)
		await modules.resolveChainChange(simulationServicesOwner, new Map(), chainConfirmation(newIdentifier, false))
		assert.equal((await newDialog).error?.code, 4001)
	})
})
