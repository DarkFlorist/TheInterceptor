import * as assert from 'assert'
import { test } from 'bun:test'

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

let storageReadCount = 0

Object.defineProperty(globalThis, 'browser', {
	configurable: true,
	writable: true,
	value: {
		storage: {
			local: {
				async get(keys: string | readonly string[]) {
					const snapshot = storageReadCount++ === 0 ? firstSnapshot : secondSnapshot
					const requestedKeys = Array.isArray(keys) ? keys : [keys]
					return Object.fromEntries(Object.entries(snapshot).filter(([key]) => requestedKeys.includes(key)))
				},
				async set() {
					throw new Error('Valid settings should not require repair writes')
				},
			},
		},
	},
})

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
