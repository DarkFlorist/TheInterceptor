import { getRequiredSettings } from './requiredSettings.js'
import * as assert from 'assert'
import { test } from 'bun:test'
import { Settings } from '../../app/ts/types/interceptor-messages.js'
import { serialize } from '../../app/ts/types/wire-types.js'

const firstRpc = {
	name: 'First network',
	chainId: '0x1',
	httpsRpc: 'https://first.example',
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	primary: true,
	minimized: true,
}

const firstSnapshot = {
	independentActiveSimulationAddress: '0x1111111111111111111111111111111111111111',
	activeSigningSafeAddress: '0x3333333333333333333333333333333333333333',
	openedPageV2: { page: 'Home' },
	useSignersAddressAsActiveAddress: false,
	websiteAccess: [],
	simulationMode: true,
	activeRpcNetwork: firstRpc,
	rpcEntries: [firstRpc],
}

const secondRpc = {
	name: 'Second network',
	chainId: '0xa',
	httpsRpc: 'https://second.example',
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	primary: true,
	minimized: true,
}

const secondSnapshot = {
	independentActiveSimulationAddress: '0x2222222222222222222222222222222222222222',
	activeSigningSafeAddress: '0x4444444444444444444444444444444444444444',
	openedPageV2: { page: 'Settings' },
	useSignersAddressAsActiveAddress: true,
	websiteAccess: [],
	simulationMode: false,
	activeRpcNetwork: secondRpc,
	rpcEntries: [secondRpc],
}

let storageReadCount = 0
let storageReadError: Error | undefined

Object.defineProperty(globalThis, 'browser', {
	configurable: true,
	writable: true,
	value: {
		storage: {
			local: {
				async get(keys: string | readonly string[]) {
					if (storageReadError !== undefined) throw storageReadError
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

const { captureRpcNetwork, getAdmittedRpcNetworkSnapshot, settingsForPublication } = await import('../../app/ts/background/settings.js')
const rereadSettingsForPublication = async (settings: Awaited<ReturnType<typeof getRequiredSettings>>) => settingsForPublication(await getAdmittedRpcNetworkSnapshot(captureRpcNetwork(settings)), settings)

test('a required settings read is one atomic browser storage snapshot', async () => {
	storageReadCount = 0

	const settings = await getRequiredSettings()

	assert.equal(storageReadCount, 1)
	assert.equal(settings.activeSimulationAddress, 0x1111111111111111111111111111111111111111n)
	assert.equal(settings.activeSigningSafeAddress, 0x3333333333333333333333333333333333333333n)
	assert.deepEqual(settings.openedPage, { page: 'Home' })
	assert.equal(settings.useSignersAddressAsActiveAddress, false)
	assert.equal(settings.simulationMode, true)
	assert.equal(settings.activeRpcNetwork.name, 'First network')
	assert.equal(settings.activeRpcNetwork.chainId, 1n)
	const serializedSettings = serialize(Settings, settings)
	assert.equal('rpcConfigurationAvailable' in serializedSettings, false)
	assert.deepEqual(Settings.parse(serializedSettings), settings)
})

test('an admitted RPC network snapshot published through settingsForPublication keeps the given RPC network and drops approvals when storage is unreadable', async () => {
	storageReadCount = 0
	storageReadError = undefined
	const settings = { ...await getRequiredSettings(), websiteAccess: [{ website: { websiteOrigin: 'approved.example', icon: undefined, title: undefined }, access: true }] }

	const reread = await rereadSettingsForPublication(settings)
	assert.equal(reread.activeRpcNetwork.name, 'First network')
	assert.equal(reread.activeSimulationAddress, 0x2222222222222222222222222222222222222222n)
	assert.equal(reread.simulationMode, false)

	storageReadError = new Error('Storage unavailable')
	try {
		assert.deepEqual(await rereadSettingsForPublication(settings), { ...settings, websiteAccess: [] })
	} finally {
		storageReadError = undefined
	}
})
