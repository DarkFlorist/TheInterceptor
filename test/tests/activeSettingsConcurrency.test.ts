import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import type { ResetSimulationServices } from '../../app/ts/simulation/serviceLifecycle.js'
import type { RpcEntry } from '../../app/ts/types/rpc.js'
import { createDeferredSignal, createEthereumWithGetBlockCounter, installBrowserMock, loadModules } from './backgroundEthAccountsTestHarness.js'

describe('active settings concurrency', () => {
	test('publishes concurrent network transitions in persisted order', async () => {
		installBrowserMock()
		const firstRpcWriteStarted = createDeferredSignal()
		const originalStorageSet = browser.storage.local.set.bind(browser.storage.local)
		let deferredFirstRpcWrite = false
		Object.defineProperty(browser.storage.local, 'set', {
			configurable: true,
			value: async (items: object) => {
				await originalStorageSet(items)
				if (deferredFirstRpcWrite || !('activeRpcNetwork' in items)) return
				deferredFirstRpcWrite = true
				firstRpcWriteStarted.resolve()
				await new Promise((resolve) => setTimeout(resolve, 0))
			},
		})
		const { changeActiveAddressAndChain, getSettings } = await loadModules()
		const previousNetwork = (await getSettings()).activeRpcNetwork
		const firstNetwork = {
			...previousNetwork,
			name: 'First network',
			chainId: 10n,
			httpsRpc: 'https://first.invalid',
			primary: false,
		} satisfies RpcEntry
		const secondNetwork = {
			...previousNetwork,
			name: 'Second network',
			chainId: 42161n,
			httpsRpc: 'https://second.invalid',
			primary: false,
		} satisfies RpcEntry
		const resetNetworks: RpcEntry[] = []
		const resetSimulationServices: ResetSimulationServices = (network) => { resetNetworks.push(network) }
		const { ethereum, tokenPriceService } = createEthereumWithGetBlockCounter({ count: 0 })

		const firstTransition = changeActiveAddressAndChain(ethereum, tokenPriceService, resetSimulationServices, new Map(), {
			simulationMode: false,
			rpcNetwork: firstNetwork,
			promptForAccessesIfNeeded: false,
		})
		await firstRpcWriteStarted.promise
		const secondTransition = changeActiveAddressAndChain(ethereum, tokenPriceService, resetSimulationServices, new Map(), {
			simulationMode: false,
			rpcNetwork: secondNetwork,
			promptForAccessesIfNeeded: false,
		})
		await Promise.all([firstTransition, secondTransition])

		assert.deepEqual(resetNetworks.map((network) => network.chainId), [firstNetwork.chainId, secondNetwork.chainId])
		assert.equal((await getSettings()).activeRpcNetwork.chainId, secondNetwork.chainId)
	})
})
