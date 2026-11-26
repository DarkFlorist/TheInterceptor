import { createGnosisSafeAppsBridgeMessage, parseGnosisSafeAppsBridgeMessage } from '../../app/shared/ts/gnosisSafeAppsBridgeProtocol.js'
import * as assert from 'assert'
import { test } from 'bun:test'
import { createGnosisSafeAppsErrorResponse as createNativeHostErrorResponse, isNativeGnosisSafeAppsDiscovery } from '../../app/ts/utils/nativeGnosisSafeAppsHost.js'
import { isGnosisSafeAppsDiscoveryMethod } from '../../app/shared/ts/gnosisSafeAppsProtocol.js'
import { GNOSIS_SAFE_APPS_TEST_SDK_VERSION } from '../fixtures/gnosisSafeAppsTestClient.js'
import { createGnosisSafeAppsErrorResponse, createGnosisSafeAppsRequest, isGnosisSafeAppsRequest, parseGnosisSafeAppsRequest, parseGnosisSafeAppsResponse, GNOSIS_SAFE_APPS_RESPONSE_VERSION } from '../../app/shared/ts/gnosisSafeAppsProtocol.js'

test('the extension host and inpage provider consume the same runtime protocol policy', () => {
	assert.equal(isNativeGnosisSafeAppsDiscovery, isGnosisSafeAppsDiscoveryMethod)
	assert.equal(createNativeHostErrorResponse, createGnosisSafeAppsErrorResponse)
})

test('the host and provider use one SDK version validator and preserve request parameters', () => {
	for (const version of ['9.1.0', '1.0.0', '9.1.0-beta.1', '9.1.0+build-2']) {
		const request = { id: 'version-test', method: 'rpcCall', env: { sdkVersion: version }, params: { call: 'eth_chainId' } }
		assert.equal(isGnosisSafeAppsRequest(request), true)
		assert.deepEqual(parseGnosisSafeAppsRequest(request), { id: request.id, request })
	}
	for (const version of ['01.2.3', '0.1.0', '9.1.0-', '9.1.0+bad suffix', '9.1.0/invalid', 'invalid']) {
		const request = { id: 'version-test', method: 'getSafeInfo', env: { sdkVersion: version } }
		assert.equal(isGnosisSafeAppsRequest(request), false)
		assert.deepEqual(parseGnosisSafeAppsRequest(request), { id: request.id, error: 'Gnosis Safe Apps env.sdkVersion must be a supported semantic version.' })
	}
	assert.equal(createGnosisSafeAppsRequest('prepare', 'getSafeInfo').env.sdkVersion, GNOSIS_SAFE_APPS_RESPONSE_VERSION)
})

test('private wrapper carries correlation independently of canonical SDK rejection envelopes', () => {
	const bridgeToken = 'host-token'
	const rejections: readonly { readonly request: { readonly id: string }, readonly error: string }[] = [
		{ request: { id: 'bad-version', method: 'getSafeInfo', env: { sdkVersion: 'invalid' }, bridgeToken }, error: 'Gnosis Safe Apps env.sdkVersion must be a supported semantic version.' },
		{ request: { id: 'bad-method', method: 1, env: { sdkVersion: '9.1.0' }, bridgeToken }, error: 'Gnosis Safe Apps method must be a string.' },
	]
	for (const { request, error } of rejections) {
		const parsed = parseGnosisSafeAppsRequest(request)
		assert.deepEqual(parsed, { id: request.id, error })
		assert.ok(parsed !== undefined && 'error' in parsed)
		const envelope = createGnosisSafeAppsErrorResponse(parsed, parsed.error)
		assert.deepEqual(envelope, { id: request.id, success: false, error, version: GNOSIS_SAFE_APPS_RESPONSE_VERSION })
		assert.deepEqual(parseGnosisSafeAppsBridgeMessage(createGnosisSafeAppsBridgeMessage(envelope, bridgeToken)), { type: 'interceptor_gnosis_safe_apps_bridge', bridgeToken, envelope })
	}
})

// Pin the independent test peer to the wire version, without an installed SDK.
test('the Gnosis Safe Apps response version matches the independent wire fixture', () => {
	assert.equal(GNOSIS_SAFE_APPS_RESPONSE_VERSION, GNOSIS_SAFE_APPS_TEST_SDK_VERSION)
})


test('canonical SDK envelopes never include internal correlation metadata', () => {
	const request = createGnosisSafeAppsRequest('sdk-id', 'getSafeInfo')
	const response = { id: request.id, success: true, data: { chainId: 1 } }
	assert.deepEqual(parseGnosisSafeAppsRequest({ ...request, bridgeToken: 'page-supplied' }), { id: request.id, request })
	assert.deepEqual(parseGnosisSafeAppsResponse({ ...response, bridgeToken: 'page-supplied' }), response)
	assert.equal(parseGnosisSafeAppsRequest(createGnosisSafeAppsBridgeMessage(request, 'private')), undefined)
	assert.equal(parseGnosisSafeAppsResponse(createGnosisSafeAppsBridgeMessage(response, 'private')), undefined)
	for (const value of [undefined, {}, { type: 'interceptor_gnosis_safe_apps_bridge', bridgeToken: 1, envelope: request }, { type: 'interceptor_gnosis_safe_apps_bridge', bridgeToken: 'private' }]) assert.equal(parseGnosisSafeAppsBridgeMessage(value), undefined)
})
