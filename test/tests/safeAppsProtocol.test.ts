import * as assert from 'assert'
import { test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { getSDKVersion } from '@safe-global/safe-apps-sdk'
import { createSafeAppsErrorResponse, createSafeAppsRequest, isSafeAppsRequest, parseSafeAppsRequest, SAFE_APPS_PREPARATION_CANCEL_MESSAGE, SAFE_APPS_RESPONSE_VERSION } from '../../app/inpage/ts/safeAppsProtocol.js'
import { SAFE_APPS_PREPARATION_CANCEL_MESSAGE as BACKGROUND_SAFE_APPS_PREPARATION_CANCEL_MESSAGE } from '../../app/ts/background/prepareSafeApp.js'

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

test('provider rejections of host-forwarded requests echo the bridge token the host requires', () => {
	const bridgeToken = 'host-token'
	const rejections: readonly { readonly request: { readonly id: string }, readonly error: string }[] = [
		{ request: { id: 'bad-version', method: 'getSafeInfo', env: { sdkVersion: 'invalid' }, bridgeToken }, error: 'Safe Apps env.sdkVersion must be a supported semantic version.' },
		{ request: { id: 'bad-method', method: 1, env: { sdkVersion: '9.1.0' }, bridgeToken }, error: 'Safe Apps method must be a string.' },
	]
	for (const { request, error } of rejections) {
		const parsed = parseSafeAppsRequest(request)
		assert.deepEqual(parsed, { id: request.id, error, bridgeToken })
		assert.ok(parsed !== undefined && 'error' in parsed)
		assert.deepEqual(createSafeAppsErrorResponse(parsed, parsed.error), { id: request.id, success: false, error, version: SAFE_APPS_RESPONSE_VERSION, bridgeToken })
	}
})

// The SDK is only a test dependency, so this check guards version drift without the production bundler loading it.
test('the Safe Apps response version matches the installed Safe Apps SDK', () => {
	assert.equal(SAFE_APPS_RESPONSE_VERSION, getSDKVersion())
})

test('the background reports the same preparation cancellation message as the injected page', () => {
	assert.equal(BACKGROUND_SAFE_APPS_PREPARATION_CANCEL_MESSAGE, SAFE_APPS_PREPARATION_CANCEL_MESSAGE)
})

test('page-injected sources import only sibling modules inside app/inpage/ts', () => {
	const inpageSourceDirectory = 'app/inpage/ts'
	const moduleSpecifierPattern = /\b(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|\bimport\s*\(?\s*['"]([^'"]+)['"]/g
	const sourceFiles = fs.readdirSync(inpageSourceDirectory).filter((file) => file.endsWith('.ts'))
	assert.ok(sourceFiles.length > 0)
	for (const file of sourceFiles) {
		const source = fs.readFileSync(path.join(inpageSourceDirectory, file), 'utf8')
		for (const match of source.matchAll(moduleSpecifierPattern)) {
			const specifier = match[1] ?? match[2]
			assert.match(specifier ?? '', /^\.\/[\w-]+\.js$/, `${ file } imports ${ specifier ?? 'an unknown module' } from outside app/inpage/ts`)
		}
	}
})
