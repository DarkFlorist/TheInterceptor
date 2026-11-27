import * as assert from 'node:assert/strict'
import { test } from 'bun:test'
import { isExtensionFrameFetchPreparationHint } from '../../app/inpage/ts/extensionFrameFetchPreparation.js'

const chromiumHost = 'chrome-extension://abcdefghijklmnop'
const firefoxHost = 'moz-extension://e6d3a4d4-4004-4cda-9f64-19c4c4059ae4/html/gnosisSafeAppsHost.html?sourceTabId=1'

test('Chrome ancestor origins and Firefox referrers enable bounded frame preparation', () => {
	assert.equal(isExtensionFrameFetchPreparationHint({ framed: true, ancestorOrigin: chromiumHost }), true)
	assert.equal(isExtensionFrameFetchPreparationHint({ framed: true, referrer: firefoxHost }), true)
})

test('top-level pages and ordinary web parents do not prepare fetch', () => {
	assert.equal(isExtensionFrameFetchPreparationHint({ framed: false, ancestorOrigin: chromiumHost, referrer: firefoxHost }), false)
	for (const referrer of [undefined, '', 'https://app.safe.global/', 'https://example.test/moz-extension://fake']) assert.equal(isExtensionFrameFetchPreparationHint({ framed: true, referrer }), false)
})

test('an available Chrome ancestor takes precedence over the referrer fallback', () => {
	for (const ancestorOrigin of ['', 'null', 'https://example.test']) assert.equal(isExtensionFrameFetchPreparationHint({ framed: true, ancestorOrigin, referrer: firefoxHost }), false)
})

test('the hint intentionally recognizes other extensions without claiming native-host authority', () => {
	assert.equal(isExtensionFrameFetchPreparationHint({ framed: true, referrer: 'moz-extension://another-extension/unrelated.html' }), true)
})
