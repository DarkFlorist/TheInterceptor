import * as assert from 'node:assert'
import { spyOn, test } from 'bun:test'
import { initializeGnosisSafeSessionCapabilities } from '../../app/ts/background/gnosisSafeSessionCapabilitiesCoordinator.js'
import { getGnosisSafeAppsCompatibilityMode, getSiteRpcInterceptionEnabled, setGnosisSafeAppsCompatibilityMode, setSiteRpcInterceptionEnabled } from '../../app/ts/background/settings.js'
import { createDeferredSignal, installBrowserMock } from './backgroundEthAccountsTestHarness.js'

function target() {
	const enabled: boolean[] = []
	let disposals = 0
	return { enabled, get disposals() { return disposals }, feature: { lifecycle: {}, setEnabled: (value: boolean) => { enabled.push(value) }, dispose: () => { disposals++ } } }
}

for (const hosting of [false, true]) for (const reads of [false, true]) test(`capability preferences remain independent: hosting=${ hosting }, HTTP reads=${ reads }`, async () => {
	installBrowserMock()
	await browser.storage.local.set({ safeAppsCompatibilityMode: hosting, siteRpcInterceptionEnabled: reads })
	const sdk = target()
	const site = target()
	const dispose = await initializeGnosisSafeSessionCapabilities({ sdk: sdk.feature, site: site.feature })
	assert.deepEqual(sdk.enabled, [hosting])
	assert.deepEqual(site.enabled, [reads])
	await setGnosisSafeAppsCompatibilityMode(!hosting)
	assert.deepEqual(sdk.enabled, [hosting, !hosting])
	assert.deepEqual(site.enabled, [reads])
	await setSiteRpcInterceptionEnabled(!reads)
	assert.deepEqual(site.enabled, [reads, !reads])
	assert.deepEqual(sdk.enabled, [hosting, !hosting])
	dispose()
	await setGnosisSafeAppsCompatibilityMode(hosting)
	await setSiteRpcInterceptionEnabled(reads)
	assert.deepEqual(sdk.enabled, [hosting, !hosting])
	assert.deepEqual(site.enabled, [reads, !reads])
	assert.equal(sdk.disposals, 1)
	assert.equal(site.disposals, 1)
})

for (const key of ['safeAppsCompatibilityMode', 'siteRpcInterceptionEnabled']) test(`a newer ${ key } event wins over a suspended startup read`, async () => {
	const mock = installBrowserMock()
	const started = createDeferredSignal()
	const release = createDeferredSignal()
	let held = false
	mock.setStorageHooks({ afterGet: async (keys) => {
		if (held || !(keys === key || (Array.isArray(keys) && keys.includes(key)))) return
		held = true
		started.resolve()
		await release.promise
	} })
	const sdk = target()
	const site = target()
	const initializing = initializeGnosisSafeSessionCapabilities({ sdk: sdk.feature, site: site.feature })
	await started.promise
	try { await browser.storage.local.set({ [key]: true }) } finally { release.resolve() }
	const dispose = await initializing
	assert.deepEqual((key === 'safeAppsCompatibilityMode' ? sdk : site).enabled, [true])
	dispose()
})

test('initialization failure cleans up the independently successful capability and both observers', async () => {
	installBrowserMock()
	const failure = new Error('Hosting preference unavailable')
	const get = spyOn(browser.storage.local, 'get').mockRejectedValueOnce(failure)
	const sdk = target()
	const site = target()
	try { await assert.rejects(initializeGnosisSafeSessionCapabilities({ sdk: sdk.feature, site: site.feature }), failure) } finally { get.mockRestore() }
	await setGnosisSafeAppsCompatibilityMode(true)
	await setSiteRpcInterceptionEnabled(true)
	assert.deepEqual(sdk.enabled, [])
	assert.deepEqual(site.enabled, [false])
	assert.equal(sdk.disposals, 1)
	assert.equal(site.disposals, 1)
})

test('the historical hosting key never enables website HTTP reads', async () => {
	installBrowserMock()
	await browser.storage.local.set({ safeAppsCompatibilityMode: true })
	assert.equal(await getGnosisSafeAppsCompatibilityMode(), true)
	assert.equal(await getSiteRpcInterceptionEnabled(), false)
	await setSiteRpcInterceptionEnabled(true)
	await setGnosisSafeAppsCompatibilityMode(false)
	assert.equal(await getGnosisSafeAppsCompatibilityMode(), false)
	assert.equal(await getSiteRpcInterceptionEnabled(), true)
})

test('a delayed successful initializer is disposed after its peer has already failed', async () => {
	const mock = installBrowserMock()
	const started = createDeferredSignal()
	const release = createDeferredSignal()
	mock.setStorageHooks({ afterGet: async (keys) => {
		if (keys !== 'siteRpcInterceptionEnabled' && !(Array.isArray(keys) && keys.includes('siteRpcInterceptionEnabled'))) return
		started.resolve()
		await release.promise
	} })
	const failure = new Error('Hosting preference unavailable')
	const get = spyOn(browser.storage.local, 'get').mockRejectedValueOnce(failure)
	const sdk = target()
	const site = target()
	const initializing = initializeGnosisSafeSessionCapabilities({ sdk: sdk.feature, site: site.feature })
	try {
		await started.promise
		await browser.storage.local.set({ siteRpcInterceptionEnabled: true })
		release.resolve()
		await assert.rejects(initializing, failure)
	} finally { release.resolve(); get.mockRestore() }
	await setSiteRpcInterceptionEnabled(false)
	assert.deepEqual(site.enabled, [true], 'cleanup detaches the late successful initializer')
	assert.equal(site.disposals, 1)
	assert.equal(sdk.disposals, 1)
})
