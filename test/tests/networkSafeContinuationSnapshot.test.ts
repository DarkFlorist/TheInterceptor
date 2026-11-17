import { test } from 'bun:test'
import * as assert from 'node:assert'
import { installBrowserMock, loadModules } from './backgroundEthAccountsTestHarness.js'
import { createRecordingServicesOwner, networkA, networkB } from './networkTransitionTestHarness.js'

test('a Gnosis Safe confirmation re-read continues its request only if no network change committed since, even one back to the same endpoint', async () => {
		installBrowserMock()
		const modules = await loadModules()
		const { readsShareNetworkAndStackContext } = await import('../../app/ts/background/windows/confirmTransaction.js')
		await modules.changeSimulationMode({ simulationMode: true, rpcNetwork: networkA })
		const { owner, retireAll } = createRecordingServicesOwner(networkA)
		try {
			const requestNetwork = await modules.readNetworkSnapshot(owner)
			assert.equal(readsShareNetworkAndStackContext(requestNetwork, await modules.readNetworkSnapshot(owner)), true)

			await modules.changeActiveAddressAndChain(owner, new Map(), { simulationMode: true, rpcNetwork: networkB, promptForAccessesIfNeeded: false })
			await modules.changeActiveAddressAndChain(owner, new Map(), { simulationMode: true, rpcNetwork: networkA, promptForAccessesIfNeeded: false })
			const afterReturningToA = await modules.readNetworkSnapshot(owner)
			assert.deepEqual(afterReturningToA.settings.activeRpcNetwork, requestNetwork.settings.activeRpcNetwork)
			assert.equal(readsShareNetworkAndStackContext(requestNetwork, afterReturningToA), false)
		} finally {
			retireAll()
		}
	})
