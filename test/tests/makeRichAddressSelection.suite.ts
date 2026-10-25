import * as assert from 'node:assert'
import { test } from 'bun:test'
import { activeAddress, fakeRpcNetwork, modules } from './confirmTransactionTestHarness.js'

const fixedRichAddress = 0x3000000000000000000000000000000000000003n

// The simulation input and the exported simulation stack fund the current account: the input through its settings snapshot, the export by reading storage.
test('the simulation input and the exported simulation stack fund the same current account', async () => {
	const { getAddressToMakeRich, selectAddressToMakeRich } = await import('../../app/ts/simulation/services/SimulationModeEthereumClientService.js')
	const { captureStackSimulationContext } = await import('../../app/ts/background/simulationUpdating.js')
	const { getSettings } = await import('../../app/ts/background/settings.js')
	for (const simulationMode of [true, false]) {
		for (const makeCurrentAddressRich of [true, false]) {
			await modules.browserStorageLocalSet({ simulationMode, makeCurrentAddressRich, activeRpcNetwork: fakeRpcNetwork, useSignersAddressAsActiveAddress: false, independentActiveSimulationAddress: activeAddress, fixedAddressRichList: [{ address: fixedRichAddress, makingRich: true, type: 'UserAdded' }] })
			const currentAccountMadeRich = simulationMode && makeCurrentAddressRich ? activeAddress : undefined
			const addressesMadeRich = simulationMode ? [fixedRichAddress, ...currentAccountMadeRich === undefined ? [] : [currentAccountMadeRich]] : []
			const settingsCase = `simulationMode: ${ simulationMode }, makeCurrentAddressRich: ${ makeCurrentAddressRich }`

			assert.equal(selectAddressToMakeRich(await getSettings(), makeCurrentAddressRich), currentAccountMadeRich, settingsCase)
			assert.equal(await getAddressToMakeRich(), currentAccountMadeRich, settingsCase)
			assert.deepEqual((await captureStackSimulationContext()).context.richAddresses, addressesMadeRich, settingsCase)
		}
	}
})
