import * as assert from 'node:assert/strict'
import { beforeEach, test } from 'bun:test'
import { DEFAULT_ACTIVE_ADDRESSES } from '../../app/ts/config/defaults.js'

const storedItems: Record<string, unknown> = {}
const writes: Record<string, unknown>[] = []
Object.defineProperty(globalThis, 'browser', {
	configurable: true,
	writable: true,
	value: { storage: { local: {
		get: async () => storedItems,
		set: async (items: Record<string, unknown>) => { writes.push({ ...items }); Object.assign(storedItems, items) },
	} } },
})
const { browserStorageLocalSafeParse } = await import('../../app/ts/utils/storageUtils.js')
const { getSettings } = await import('../../app/ts/background/settings.js')

beforeEach(() => {
	for (const key of Object.keys(storedItems)) delete storedItems[key]
	writes.length = 0
})

test('settings validate each website once instead of traversing unrelated storage unions', async () => {
	let websiteReads = 0
	storedItems.websiteAccess = [{
		get website() { websiteReads += 1; return { websiteOrigin: 'denied.example' } },
		access: false,
	}]
	const settings = await getSettings()
	assert.equal(websiteReads, 1)
	assert.equal(settings.websiteAccess[0]?.access, false)
	assert.equal(writes.length, 0)
})

test('settings distinguish missing addresses from explicit clears', async () => {
	const defaultSettings = await getSettings()
	assert.equal(defaultSettings.activeSimulationAddress, DEFAULT_ACTIVE_ADDRESSES[0]?.address)
	storedItems.independentActiveSimulationAddress = 'missing'
	storedItems.activeSigningSafeAddress = 'missing'
	const clearedSettings = await getSettings()
	assert.equal(clearedSettings.activeSimulationAddress, undefined)
	assert.equal(clearedSettings.activeSigningSafeAddress, undefined)
	assert.equal(writes.length, 0)
})

test('a corrupt setting is repaired without discarding other valid settings', async () => {
	storedItems.simulationMode = 'invalid'
	storedItems.useSignersAddressAsActiveAddress = true
	storedItems.independentActiveSimulationAddress = '0x0000000000000000000000000000000000000002'
	const settings = await getSettings()
	assert.equal(settings.simulationMode, true)
	assert.equal(settings.useSignersAddressAsActiveAddress, true)
	assert.equal(settings.activeSimulationAddress, 2n)
	assert.deepEqual(writes, [{ simulationMode: true }])
})

test('corrupt address repairs use the canonical storage encoding and survive startup', async () => {
	storedItems.independentActiveSimulationAddress = 'invalid'
	storedItems.activeSigningSafeAddress = 'invalid'
	const settings = await getSettings()
	const parsed = browserStorageLocalSafeParse(storedItems)
	assert.ok(parsed !== undefined)
	assert.equal(parsed.independentActiveSimulationAddress, settings.activeSimulationAddress)
	assert.ok(Object.hasOwn(parsed, 'activeSigningSafeAddress'))
	assert.equal(parsed.activeSigningSafeAddress, undefined)
	assert.equal(storedItems.activeSigningSafeAddress, 'missing')
	assert.deepEqual(await getSettings(), settings)
	assert.equal(writes.length, 2)
})
