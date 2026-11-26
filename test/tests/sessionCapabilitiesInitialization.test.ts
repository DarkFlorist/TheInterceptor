import * as assert from 'node:assert'
import * as fs from 'node:fs'
import { spyOn, test } from 'bun:test'
import { initializeGnosisSafeSessionCapabilities } from '../../app/ts/background/gnosisSafeSessionCapabilitiesCoordinator.js'
import { getGnosisSafeSessionCompatibilityMode, setGnosisSafeSessionCompatibilityMode } from '../../app/ts/background/settings.js'
import { createDeferredSignal, installBrowserMock } from './backgroundEthAccountsTestHarness.js'

function target() {
	const enabled: boolean[] = []
	let disposals = 0
	return { enabled, get disposals() { return disposals }, feature: { lifecycle: {}, setEnabled: (value: boolean) => { enabled.push(value) }, dispose: () => { disposals++ } } }
}

test('the session owner preserves a newer preference event over a suspended startup read and detaches on disposal', async () => {
	const mock = installBrowserMock()
	const started = createDeferredSignal()
	const release = createDeferredSignal()
	let held = false
	mock.setStorageHooks({ afterGet: async (keys) => {
		if (held || !(keys === 'safeAppsCompatibilityMode' || (Array.isArray(keys) && keys.includes('safeAppsCompatibilityMode')))) return
		held = true
		started.resolve()
		await release.promise
	} })
	const state = target()
	const initializing = initializeGnosisSafeSessionCapabilities(state.feature)
	await started.promise
	try { await setGnosisSafeSessionCompatibilityMode(true) } finally { release.resolve() }
	const dispose = await initializing
	assert.deepEqual(state.enabled, [true], 'the stale startup value cannot override a live preference change')
	dispose()
	await setGnosisSafeSessionCompatibilityMode(false)
	assert.deepEqual(state.enabled, [true], 'disposed session initialization observes no further changes')
	assert.equal(state.disposals, 1)
})

test('session initialization failure detaches its observer and disposes the combined capability target', async () => {
	installBrowserMock()
	const failure = new Error('Session preference unavailable')
	const get = spyOn(browser.storage.local, 'get').mockRejectedValueOnce(failure)
	const state = target()
	try { await assert.rejects(initializeGnosisSafeSessionCapabilities(state.feature), failure) } finally { get.mockRestore() }
	await setGnosisSafeSessionCompatibilityMode(true)
	assert.deepEqual(state.enabled, [])
	assert.equal(state.disposals, 1)
})

test('combined capability initialization is implemented by the session composition owner', () => {
	const session = fs.readFileSync('app/ts/background/gnosisSafeSessionCapabilitiesCoordinator.ts', 'utf8')
	const sdk = fs.readFileSync('app/ts/background/gnosisSafeAppsCompatibilityCoordinator.ts', 'utf8')
	assert.match(session, /export async function initializeGnosisSafeSessionCapabilities\(/u)
	assert.doesNotMatch(session, /initializeGnosisSafeAppsCompatibility/u)
	assert.doesNotMatch(sdk, /initializeGnosisSafeAppsCompatibility/u)
})


test('session compatibility retains the historical preference key for SDK hosting and simulated website reads', async () => {
	installBrowserMock()
	await browser.storage.local.set({ safeAppsCompatibilityMode: true })
	assert.equal(await getGnosisSafeSessionCompatibilityMode(), true)
	await setGnosisSafeSessionCompatibilityMode(false)
	assert.equal(await getGnosisSafeSessionCompatibilityMode(), false)
	assert.deepEqual(await browser.storage.local.get(['safeAppsCompatibilityMode', 'gnosisSafeSessionCompatibilityMode']), { safeAppsCompatibilityMode: false })
})
