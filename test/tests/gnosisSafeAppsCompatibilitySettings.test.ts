import * as assert from 'node:assert'
import { test } from 'bun:test'
import { createDeferredSignal, installBrowserMock } from './backgroundEthAccountsTestHarness.js'
import { exportSettingsAndAddressBook, getGnosisSafeSessionCompatibilityMode, setGnosisSafeSessionCompatibilityMode } from '../../app/ts/background/settings.js'
import { importSettingsAndAddressBook } from '../../app/ts/background/settingsImport.js'

const readsMode = (keys: unknown) => keys === 'safeAppsCompatibilityMode' || (Array.isArray(keys) && keys.includes('safeAppsCompatibilityMode'))

function holdNextModeRead(mock: ReturnType<typeof installBrowserMock>) {
	const started = createDeferredSignal()
	const release = createDeferredSignal()
	const writes: boolean[] = []
	let held = false
	mock.setStorageHooks({
		afterGet: async (keys) => {
			if (!readsMode(keys) || held) return
			held = true
			started.resolve()
			await release.promise
		},
		beforeSet: async (items) => { if (typeof items.safeAppsCompatibilityMode === 'boolean') writes.push(items.safeAppsCompatibilityMode) },
	})
	return { started: started.promise, release: release.resolve, writes }
}

for (const initial of [false, true]) test(`a later compatibility selection wins while the preceding ${ initial ? 'disable' : 'enable' } read is suspended`, async () => {
	const mock = installBrowserMock()
	await setGnosisSafeSessionCompatibilityMode(initial)
	const gate = holdNextModeRead(mock)
	const first = setGnosisSafeSessionCompatibilityMode(!initial)
	await gate.started
	const last = setGnosisSafeSessionCompatibilityMode(initial)
	gate.release()
	await Promise.all([first, last])
	assert.equal(await getGnosisSafeSessionCompatibilityMode(), initial)
	assert.deepEqual(gate.writes, [!initial, initial], 'the later operation must compare with the preceding committed value')
})

test('concurrent identical compatibility selections emit only one storage transition', async () => {
	const mock = installBrowserMock()
	const gate = holdNextModeRead(mock)
	const first = setGnosisSafeSessionCompatibilityMode(true)
	await gate.started
	const rest = [setGnosisSafeSessionCompatibilityMode(true), setGnosisSafeSessionCompatibilityMode(true)]
	gate.release()
	await Promise.all([first, ...rest])
	assert.equal(await getGnosisSafeSessionCompatibilityMode(), true)
	assert.deepEqual(gate.writes, [true], 'queued no-op selections must not invalidate the Firefox app session')
})

test('compatibility selections share the settings-import transaction lock', async () => {
	const mock = installBrowserMock()
	const disabledSettings = await exportSettingsAndAddressBook()
	await setGnosisSafeSessionCompatibilityMode(true)
	const started = createDeferredSignal()
	const release = createDeferredSignal()
	let modeReads = 0
	mock.setStorageHooks({
		afterGet: async (keys) => { if (readsMode(keys)) modeReads++ },
		afterSet: async (items) => {
			if (items.safeAppsCompatibilityMode !== false) return
			started.resolve()
			await release.promise
		},
	})
	const importing = importSettingsAndAddressBook(disabledSettings)
	await started.promise
	const enabling = setGnosisSafeSessionCompatibilityMode(true)
	try {
		assert.equal(modeReads, 0, 'a selection cannot read through an unfinished settings import')
	} finally {
		release.resolve()
		await Promise.all([importing, enabling])
	}
	assert.equal(await getGnosisSafeSessionCompatibilityMode(), true)
})

test('a failed compatibility write releases the transaction for subsequent selections', async () => {
	const mock = installBrowserMock()
	const failure = new Error('Compatibility write unavailable')
	let fail = true
	mock.setStorageHooks({ beforeSet: async (items) => {
		if (items.safeAppsCompatibilityMode !== true || !fail) return
		fail = false
		throw failure
	} })
	const [enable, disable] = await Promise.allSettled([setGnosisSafeSessionCompatibilityMode(true), setGnosisSafeSessionCompatibilityMode(false)])
	assert.ok(enable?.status === 'rejected')
	assert.equal(enable.reason, failure)
	assert.equal(disable?.status, 'fulfilled')
	assert.equal(await getGnosisSafeSessionCompatibilityMode(), false)
	await setGnosisSafeSessionCompatibilityMode(true)
	assert.equal(await getGnosisSafeSessionCompatibilityMode(), true)
})
