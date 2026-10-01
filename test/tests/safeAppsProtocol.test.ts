import * as assert from 'assert'
import { test } from 'bun:test'
import { createSafeAppsRequest, isSafeAppsRequest, parseSafeAppsRequest, SAFE_APPS_RESPONSE_VERSION } from '../../app/inpage/ts/safeAppsProtocol.js'

test('the host and provider use one SDK version validator and preserve request parameters', () => {
	for (const version of ['9.1.0', '1.0.0', '9.1.0-beta.1', '9.1.0+build-2']) {
		const request = { id: 'version-test', method: 'rpcCall', env: { sdkVersion: version }, params: { call: 'eth_chainId' } }
		assert.equal(isSafeAppsRequest(request), true)
		assert.deepEqual(parseSafeAppsRequest(request), { id: request.id, request })
	}
	for (const version of ['01.2.3', '0.1.0', '9.1.0-', '9.1.0+bad suffix', '9.1.0/invalid', 'invalid']) {
		const request = { id: 'version-test', method: 'getSafeInfo', env: { sdkVersion: version } }
		assert.equal(isSafeAppsRequest(request), false)
		assert.deepEqual(parseSafeAppsRequest(request), { id: request.id, error: 'Safe Apps env.sdkVersion must be a supported semantic version.' })
	}
	assert.equal(createSafeAppsRequest('prepare', 'getSafeInfo').env.sdkVersion, SAFE_APPS_RESPONSE_VERSION)
})
