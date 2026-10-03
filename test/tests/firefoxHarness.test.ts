import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { parseExtensionUuidPreference } from '../benchmarks/firefoxHarness.js'

const extensionId = '{3c236fbc-9114-43ed-a224-0cd1834aec4d}'
const extensionUuid = 'ca8a5848-465b-4a49-9f09-4c49436b42cf'

function buildUuidPreference(mappings: unknown) {
	return `user_pref("extensions.webextensions.uuids", ${ JSON.stringify(JSON.stringify(mappings)) });`
}

describe('Firefox extension UUID preference parsing', () => {
	test('returns the mapped internal extension UUID', () => {
		assert.equal(parseExtensionUuidPreference(buildUuidPreference({ [extensionId]: extensionUuid }), extensionId), extensionUuid)
	})

	test('waits for a missing or incomplete preference', () => {
		assert.equal(parseExtensionUuidPreference('', extensionId), undefined)
		assert.equal(parseExtensionUuidPreference('user_pref("extensions.webextensions.uuids", ', extensionId), undefined)
	})

	test('reports malformed encoded preference JSON', () => {
		assert.throws(
			() => parseExtensionUuidPreference('user_pref("extensions.webextensions.uuids", invalid);', extensionId),
			/Could not parse Firefox extension UUID preference/u,
		)
	})

	test('reports malformed mapping JSON and shape', () => {
		assert.throws(
			() => parseExtensionUuidPreference(`user_pref("extensions.webextensions.uuids", ${ JSON.stringify('{') });`, extensionId),
			/Could not parse Firefox extension UUID mapping/u,
		)
		assert.throws(
			() => parseExtensionUuidPreference(buildUuidPreference([]), extensionId),
			/Firefox extension UUID mapping must be an object/u,
		)
	})
})
