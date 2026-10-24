import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import type { FetchSimulationStackRequestConfirmation } from '../../app/ts/types/interceptor-messages.js'
import type { SimulationStackSnapshot } from '../../app/ts/background/windows/fetchSimulationStack.js'
import type { GetSimulationStack } from '../../app/ts/types/JsonRpc-types.js'
import type { RpcEntry } from '../../app/ts/types/rpc.js'
import type { InterceptedRequest } from '../../app/ts/utils/requests.js'
import { waitForValue } from '../harness/async.js'
import { installBrowserMock } from '../harness/browserMock.js'
import { createPerTestBrowserMockInstaller } from '../harness/perTest.js'

// The app modules are imported after the browser globals exist, as in the extension.
installBrowserMock()
const installBrowserMockForTest = createPerTestBrowserMockInstaller()

const modulesPromise = import('../../app/ts/background/windows/fetchSimulationStack.js')
const storageVariablesPromise = import('../../app/ts/background/storageVariables.js')

const blockTimeManipulation = { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' } as const
const rpcNetwork: RpcEntry = {
	name: 'Test RPC',
	chainId: 1n,
	httpsRpc: 'https://rpc.example',
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	primary: true,
	minimized: false,
}
const getSimulationStackParams: GetSimulationStack = { method: 'interceptor_getSimulationStack', params: ['2.0.0'] }

const createStateOverrides = (balance: bigint) => ({ '0x0000000000000000000000000000000000000001': { balance } })

function createSnapshot(balance: bigint): SimulationStackSnapshot {
	const stateOverrides = createStateOverrides(balance)
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
		installBrowserMockForTest()
		const modules = await modulesPromise
		const { getFetchSimulationStackRequestPromise } = await storageVariablesPromise
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
			true,
			new Map(),
			uniqueRequestIdentifier,
			getSimulationStackParams,
			{ websiteOrigin: 'https://requester.example', icon: undefined, title: undefined },
		)
		const storedRequest = await waitForValue(getFetchSimulationStackRequestPromise, { description: 'the stored fetch simulation stack request' })
		assert.equal(storedRequest.simulationOverlayEnabled, true)
		await modules.resolveFetchSimulationStackRequest(confirmationSnapshot, new Map(), confirmation)
		const result = await pendingResult

		assert.ok(result.outcome === 'accepted')
		assert.ok(result.result.version === '2.0.0')
		assert.deepEqual(result.result.payload.stateOverrides, createStateOverrides(2n))
		assert.equal(result.simulationStackHash, modules.getSimulationStackHash(confirmationSnapshot.simulationInput))
		assert.notEqual(result.simulationStackHash, modules.getSimulationStackHash(initialSnapshot.simulationInput))
	})

	test('caches rejection for the confirmation-time snapshot only', async () => {
		const browserMock = installBrowserMockForTest()
		const modules = await modulesPromise
		const initialSnapshot = createSnapshot(3n)
		const confirmationSnapshot = createSnapshot(4n)
		const socket = { tabId: 8, connectionName: 13n }
		const website = { websiteOrigin: 'https://requester.example', icon: undefined, title: undefined }
		const params = getSimulationStackParams
		const createRequest = (requestId: number): InterceptedRequest => ({
			method: params.method,
			params: params.params,
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId, requestSocket: socket },
		})
		const reject = (requestId: number): FetchSimulationStackRequestConfirmation => ({
			method: 'popup_fetchSimulationStackRequestConfirmation',
			data: {
				accept: false,
				simulationStackVersion: '2.0.0',
				uniqueRequestIdentifier: { requestId, requestSocket: socket },
			},
		})

		const firstRequest = modules.openFetchSimulationStackDialogOrGetCachedResult(initialSnapshot, true, new Map(), params, website, createRequest(20), socket)
		await modules.resolveFetchSimulationStackRequest(confirmationSnapshot, new Map(), reject(20))
		const firstResult = await firstRequest
		assert.ok('error' in firstResult)
		assert.equal(browserMock.calls.windowsCreate.length, 1)

		const cachedConfirmationResult = await modules.openFetchSimulationStackDialogOrGetCachedResult(confirmationSnapshot, true, new Map(), params, website, createRequest(21), socket)
		assert.ok('error' in cachedConfirmationResult)
		assert.equal(browserMock.calls.windowsCreate.length, 1)

		const initialSnapshotRequest = modules.openFetchSimulationStackDialogOrGetCachedResult(initialSnapshot, true, new Map(), params, website, createRequest(22), socket)
		await modules.resolveFetchSimulationStackRequest(initialSnapshot, new Map(), reject(22))
		await initialSnapshotRequest
		assert.equal(browserMock.calls.windowsCreate.length, 2)
	})
})
