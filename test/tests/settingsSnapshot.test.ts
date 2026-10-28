import * as assert from 'node:assert'
import { test } from 'bun:test'
import { installBrowserMock } from '../harness/browserMock.js'

const firstSnapshot = {
	independentActiveSimulationAddress: '0x1111111111111111111111111111111111111111',
	activeSigningSafeAddress: '0x3333333333333333333333333333333333333333',
	openedPageV2: { page: 'Home' },
	useSignersAddressAsActiveAddress: false,
	websiteAccess: [],
	simulationMode: true,
	activeRpcNetwork: {
		name: 'First network',
		chainId: '0x1',
		httpsRpc: 'https://first.example',
		currencyName: 'Ether',
		currencyTicker: 'ETH',
		primary: true,
		minimized: true,
	},
}

const secondSnapshot = {
	independentActiveSimulationAddress: '0x2222222222222222222222222222222222222222',
	activeSigningSafeAddress: '0x4444444444444444444444444444444444444444',
	openedPageV2: { page: 'Settings' },
	useSignersAddressAsActiveAddress: true,
	websiteAccess: [],
	simulationMode: false,
	activeRpcNetwork: {
		name: 'Second network',
		chainId: '0xa',
		httpsRpc: 'https://second.example',
		currencyName: 'Ether',
		currencyTicker: 'ETH',
		primary: true,
		minimized: true,
	},
}

const browserMock = installBrowserMock({ storage: { local: firstSnapshot } })
const readStorage = browserMock.browser.storage.local.get
const writeStorage = browserMock.browser.storage.local.set
let storageReadCount = 0
// Every read after the first sees different settings, so reading storage more than once would mix two snapshots.
browserMock.browser.storage.local.get = async (keys) => {
	const items = await readStorage(keys)
	storageReadCount += 1
	if (storageReadCount === 1) await writeStorage(secondSnapshot)
	return items
}
browserMock.browser.storage.local.set = async () => {
	throw new Error('Valid settings should not require repair writes')
}

const { getSettings } = await import('../../app/ts/background/settings.js')

test('getSettings returns one atomic browser storage snapshot', async () => {
	storageReadCount = 0

	const settings = await getSettings()

	assert.equal(storageReadCount, 1)
	assert.equal(settings.activeSimulationAddress, 0x1111111111111111111111111111111111111111n)
	assert.equal(settings.activeSigningSafeAddress, 0x3333333333333333333333333333333333333333n)
	assert.deepEqual(settings.openedPage, { page: 'Home' })
	assert.equal(settings.useSignersAddressAsActiveAddress, false)
	assert.equal(settings.simulationMode, true)
	assert.equal(settings.activeRpcNetwork.name, 'First network')
	assert.equal(settings.activeRpcNetwork.chainId, 1n)
})
