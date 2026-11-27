import { nativeGnosisSafeAppsStorageChangeAffectsContext, getNativeGnosisSafeAppsContextChanges } from '../../app/ts/background/nativeGnosisSafeAppsHostContextPolicy.js'
import * as assert from 'assert'
import { test } from 'bun:test'
import { parseGnosisSafeAppsRequest } from '../../app/shared/ts/gnosisSafeAppsProtocol.js'
import { isNativeGnosisSafeAppsDiscovery, nativeGnosisSafeAppsHostUrl, parseNativeGnosisSafeAppsLaunch, parseNativeGnosisSafeAppsRequest, parseNativeGnosisSafeAppsResponse } from '../../app/ts/utils/nativeGnosisSafeAppsHost.js'
import { isGnosisSafeAppsDiscoveryMethod } from '../../app/shared/ts/gnosisSafeAppsProtocol.js'
import { getHtmlPageUrl } from '../../app/ts/utils/htmlPages.js'

test('native host only supersedes the canonical read-only discovery methods', () => {
	for (const method of ['getSafeInfo', 'getChainInfo', 'getEnvironmentInfo', 'sendTransactions', 'signMessage', 'signTypedMessage', 'submitOffChainMessage', 'rpcCall', 'future-sdk-method']) assert.equal(isNativeGnosisSafeAppsDiscovery(method), isGnosisSafeAppsDiscoveryMethod(method))
})

test('cosmetic website metadata updates preserve host context while real permission changes invalidate it', () => {
	const original = [{ website: { websiteOrigin: 'app.example', title: 'App', icon: 'old-icon' }, access: true, addressAccess: [{ address: '0x0000000000000000000000000000000000000001', access: true }] }]
	const cosmetic = [{ ...original[0], website: { websiteOrigin: 'app.example', title: 'App — Connected', icon: 'new-icon' } }]
	assert.equal(nativeGnosisSafeAppsStorageChangeAffectsContext('websiteAccess', { oldValue: original, newValue: cosmetic }), false)
	for (const updated of [[], [{ ...cosmetic[0], access: false }], [{ ...cosmetic[0], interceptorDisabled: true }], [{ ...cosmetic[0], addressAccess: [{ address: '0x0000000000000000000000000000000000000001', access: false }] }]]) assert.equal(nativeGnosisSafeAppsStorageChangeAffectsContext('websiteAccess', { oldValue: original, newValue: updated }), true)
	assert.equal(nativeGnosisSafeAppsStorageChangeAffectsContext('websiteAccess', { oldValue: original, newValue: { corrupt: true } }), true)
	assert.equal(nativeGnosisSafeAppsStorageChangeAffectsContext('simulationMode', { oldValue: true, newValue: false }), true)
})

test('transaction address metadata enrichment does not interrupt a Gnosis Safe app but wallet edits do', () => {
	const address = '0x0000000000000000000000000000000000000001'
	const safe = { type: 'safe', name: 'Gnosis Safe', address, chainId: '0x1', entrySource: 'User', useAsActiveAddress: true, askForAddressAccess: false, safeSignerAddresses: [address], safeSimulationSignerAddress: address, safeVersion: '1.4.1' }
	const enriched = { ...safe, name: 'Renamed Gnosis Safe', logoUri: 'https://example.org/logo.png', abi: '[]' }
	const contact = { type: 'contact', name: 'Transaction recipient', address: '0x0000000000000000000000000000000000000002', entrySource: 'OnChain' }
	assert.equal(nativeGnosisSafeAppsStorageChangeAffectsContext('userAddressBookEntriesV3', { oldValue: [safe], newValue: [enriched, contact] }), false)
	for (const wallet of [{ ...enriched, safeSignerAddresses: [] }, { ...enriched, safeSimulationSignerAddress: contact.address }, { ...enriched, chainId: '0x2' }, { ...enriched, useAsActiveAddress: false }, { ...enriched, askForAddressAccess: true }]) assert.equal(nativeGnosisSafeAppsStorageChangeAffectsContext('userAddressBookEntriesV3', { oldValue: [safe], newValue: [wallet, contact] }), true)
	assert.equal(nativeGnosisSafeAppsStorageChangeAffectsContext('userAddressBookEntriesV3', { oldValue: [safe], newValue: [contact] }), true)
	assert.equal(nativeGnosisSafeAppsStorageChangeAffectsContext('userAddressBookEntriesV3', { oldValue: [safe], newValue: [{ ...safe, chainId: 'invalid' }] }), true)
})

test('native host validates launch URLs and preserves the original app path and query', () => {
	const appUrl = 'https://example.org/swap?token=ether#trade'
	const host = new URL(nativeGnosisSafeAppsHostUrl('chrome-extension://test/', 123, appUrl, 3))
	assert.equal(host.pathname, '/html3/gnosisSafeAppsHostV3.html')
	assert.equal(new URL(nativeGnosisSafeAppsHostUrl('moz-extension://test/', 123, appUrl, 2)).pathname, '/html/gnosisSafeAppsHost.html')
	const launch = parseNativeGnosisSafeAppsLaunch(host.searchParams)
	assert.equal(launch.hostTabId, 123)
	assert.equal(host.searchParams.get('sourceTabId'), null)
	assert.throws(() => parseNativeGnosisSafeAppsLaunch(new URLSearchParams({ sourceTabId: '123', appUrl })), 'old original-tab launch URLs must not create a new host session')
	assert.equal(launch.appUrl.href, appUrl)
	for (const tabId of ['', '-1', '1.2', 'NaN', '9007199254740992']) assert.throws(() => parseNativeGnosisSafeAppsLaunch(new URLSearchParams({ hostTabId: tabId, appUrl })))
	for (const url of ['javascript:alert(1)', 'data:text/html,test', 'file:///app', 'https://user:password@example.org']) assert.throws(() => nativeGnosisSafeAppsHostUrl('moz-extension://test/', 1, url, 2))
})

test('the popup launcher and host authorization resolve the same current browser page variant', () => {
	const previous = Object.getOwnPropertyDescriptor(globalThis, 'browser')
	try {
		for (const manifestVersion of [2, 3]) {
			const root = manifestVersion === 2 ? 'moz-extension://test/' : 'chrome-extension://test/'
			Object.defineProperty(globalThis, 'browser', { configurable: true, value: { runtime: { getManifest: () => ({ manifest_version: manifestVersion }), getURL: (path: string) => `${ root }${ path }` } } })
			const launched = new URL(nativeGnosisSafeAppsHostUrl(root, 12, 'https://app.example'))
			const authorized = new URL(getHtmlPageUrl('gnosisSafeAppsHost'))
			assert.equal(launched.pathname, manifestVersion === 2 ? '/html/gnosisSafeAppsHost.html' : '/html3/gnosisSafeAppsHostV3.html')
			assert.equal(launched.protocol + '//' + launched.host + launched.pathname, authorized.href)
		}
	} finally {
		if (previous === undefined) Reflect.deleteProperty(globalThis, 'browser')
		else Object.defineProperty(globalThis, 'browser', previous)
	}
})

test('native SDK envelopes use the shared parser and redact private bridge tokens', () => {
	for (const version of ['9.1.0', '1.0.0', '9.1.0-beta.1', '9.1.0+build-2', '01.2.3', '0.1.0', '9.1.0-', '9.1.0+bad suffix', 'invalid']) {
		const input = { id: 'sdk', method: 'rpcCall', env: { sdkVersion: version }, params: { call: 'eth_chainId' }, bridgeToken: 'untrusted-token' }
		const canonical = parseGnosisSafeAppsRequest(input)
		const native = parseNativeGnosisSafeAppsRequest(input)
		assert.equal(native !== undefined, canonical !== undefined && 'request' in canonical)
		if (native !== undefined) {
			assert.equal(native.id, input.id)
			assert.deepEqual(native.params, input.params)
			assert.equal('bridgeToken' in native, false)
		}
	}
	for (const input of [undefined, 'sdk', {}, { id: 'sdk', method: 1, env: { sdkVersion: '9.1.0' } }, { id: 'sdk', method: 'getSafeInfo', env: {} }]) assert.equal(parseNativeGnosisSafeAppsRequest(input), undefined)
})

test('native host only accepts SDK responses with an id and explicit outcome', () => {
	assert.deepEqual(parseNativeGnosisSafeAppsResponse({ id: 'request', success: true, data: { chainId: 1 }, bridgeToken: 'private' }), { id: 'request', success: true, data: { chainId: 1 } })
	assert.equal(parseNativeGnosisSafeAppsResponse({ id: 'request', data: {} }), undefined)
	assert.equal(parseNativeGnosisSafeAppsResponse({ id: 1, success: true }), undefined)
})


test('background context projection ignores cosmetic writes and non-local changes', () => {
	const before = [{ website: { websiteOrigin: 'app.example', title: 'Before' }, access: true }]
	const after = [{ website: { websiteOrigin: 'app.example', title: 'After' }, access: true }]
	assert.deepEqual(getNativeGnosisSafeAppsContextChanges({ websiteAccess: { oldValue: before, newValue: after } }, 'local'), [])
	assert.deepEqual(getNativeGnosisSafeAppsContextChanges({ simulationMode: { newValue: false } }, 'sync'), [])
	assert.deepEqual(getNativeGnosisSafeAppsContextChanges({ simulationMode: { newValue: false }, signingAddressPreferences: { newValue: {} } }, 'local'), ['simulationMode', 'signingAddressPreferences'])
})


test('same-value storage writes do not request an app reconnection', () => {
	assert.deepEqual(getNativeGnosisSafeAppsContextChanges({ simulationMode: { oldValue: false, newValue: false }, activeSigningSafeAddress: { oldValue: '0x1234', newValue: '0x1234' } }, 'local'), [])
})

test('canonical hosting settings enumerate every context invalidation field', async () => {
	const { automaticGnosisSafeAppsHostingSettingsKeys } = await import('../../app/ts/types/contentScriptSettings.js')
	const keys = ['safeAppsCompatibilityMode', 'simulationMode', 'activeSigningSafeAddress', 'independentActiveSimulationAddress', 'useSignersAddressAsActiveAddress', 'activeRpcNetwork', 'websiteAccess', 'signingAddressPreferences', 'userAddressBookEntriesV3']
	assert.deepEqual([...automaticGnosisSafeAppsHostingSettingsKeys].sort(), [...keys].sort())
	for (const key of keys) assert.deepEqual(getNativeGnosisSafeAppsContextChanges({ [key]: { newValue: 'changed' } }, 'local'), [key])
})
