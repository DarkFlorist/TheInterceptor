import * as assert from 'node:assert'
import { test } from 'bun:test'
import { getActiveAddressSettings, haveSameActiveAddressSettings } from '../../app/ts/background/backgroundUtils.js'
import type { Settings } from '../../app/ts/types/interceptor-messages.js'

const settings: Settings = {
	activeSimulationAddress: 0xd8da6bf26964af9d7eed9e03e53415d37aa96045n,
	activeSigningSafeAddress: undefined,
	openedPage: { page: 'Home' },
	useSignersAddressAsActiveAddress: false,
	websiteAccess: [],
	activeRpcNetwork: {
		name: 'Ethereum Mainnet',
		chainId: 1n,
		httpsRpc: 'https://ethereum.dark.florist',
		currencyName: 'Ether',
		currencyTicker: 'ETH',
		currencyLogoUri: '../img/ethereum.svg',
		primary: true,
		minimized: true,
	},
	simulationMode: true,
}

test('the active-address settings are the settings that decide which account getActiveAddress resolves', () => {
	assert.deepEqual(getActiveAddressSettings(settings), {
		simulationMode: true,
		chainId: 1n,
		useSignersAddressAsActiveAddress: false,
		activeSimulationAddress: 0xd8da6bf26964af9d7eed9e03e53415d37aa96045n,
		activeSigningSafeAddress: undefined,
	})
})

test('a change to any setting that decides the active account makes the active-address settings differ', () => {
	const changes: readonly Settings[] = [
		{ ...settings, simulationMode: false },
		{ ...settings, activeRpcNetwork: { ...settings.activeRpcNetwork, chainId: 8453n } },
		{ ...settings, useSignersAddressAsActiveAddress: true },
		{ ...settings, activeSimulationAddress: 0x1000000000000000000000000000000000000001n },
		{ ...settings, activeSimulationAddress: undefined },
		{ ...settings, activeSigningSafeAddress: 0x2000000000000000000000000000000000000002n },
	]
	for (const changedSettings of changes) assert.equal(haveSameActiveAddressSettings(settings, changedSettings), false)
})

test('settings that do not decide the active account leave the active-address settings the same', () => {
	const changes: readonly Settings[] = [
		settings,
		{ ...settings, openedPage: { page: 'Settings' } },
		{ ...settings, websiteAccess: [{ website: { websiteOrigin: 'https://example.com', icon: undefined, title: undefined }, access: true, addressAccess: [] }] },
		{ ...settings, activeRpcNetwork: { ...settings.activeRpcNetwork, name: 'Renamed Mainnet' } },
	]
	for (const changedSettings of changes) assert.equal(haveSameActiveAddressSettings(settings, changedSettings), true)
})
