import * as assert from 'node:assert'
import { afterAll, beforeAll, test } from 'bun:test'
import { Settings } from '../../app/ts/types/interceptor-messages.js'

const requestedKeys: unknown[] = []
const previousBrowser = Object.getOwnPropertyDescriptor(globalThis, 'browser')
// A storage that records the keys each read asks for and stores nothing; the browser global of other test files is restored afterwards.
beforeAll(() => {
	Object.defineProperty(globalThis, 'browser', {
		value: { storage: { local: {
			async get(keys: unknown) {
				requestedKeys.push(keys)
				return {}
			},
			async set() { return undefined },
		} } },
		configurable: true,
		writable: true,
	})
})
afterAll(() => {
	if (previousBrowser === undefined) Reflect.deleteProperty(globalThis, 'browser')
	else Object.defineProperty(globalThis, 'browser', previousBrowser)
})

const { SETTINGS_FIELDS, SIMULATION_INPUT_FIELDS, getSettings, getSimulationSettingsSnapshot } = await import('../../app/ts/background/storedSettings.js')

test('every Settings field has a storage key and parser in the settings table', () => {
	assert.deepEqual(Object.keys(SETTINGS_FIELDS).sort(), Object.keys(Settings.fields).sort())
	assert.deepEqual(Object.values(SETTINGS_FIELDS).map((field) => field.storageKey).sort(), ['activeRpcNetwork', 'activeSigningSafeAddress', 'independentActiveSimulationAddress', 'openedPageV2', 'simulationMode', 'useSignersAddressAsActiveAddress', 'websiteAccess'])
})

test('settings reads fetch exactly the storage keys of the fields they parse', async () => {
	requestedKeys.length = 0
	const settings = await getSettings()
	const snapshot = await getSimulationSettingsSnapshot()
	const settingsKeys = Object.values(SETTINGS_FIELDS).map((field) => field.storageKey)
	assert.deepEqual(requestedKeys, [settingsKeys, [...settingsKeys, ...Object.values(SIMULATION_INPUT_FIELDS).map((field) => field.storageKey)]])
	assert.deepEqual(Object.keys(settings).sort(), Object.keys(Settings.fields).sort())
	assert.deepEqual(Object.keys(snapshot).sort(), ['fixedAddressRichList', 'makeCurrentAddressRich', 'preSimulationBlockTimeManipulation', 'settings'])
	assert.deepEqual(snapshot.settings, settings)
})
