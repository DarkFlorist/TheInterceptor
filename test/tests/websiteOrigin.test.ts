import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { storedWebsiteOriginCases } from './storedWebsiteOriginCases.js'
import { doesStoredWebsiteOriginApplyTo, getHostWithPort, getStoredWebsiteHost, getWebsiteOrigin } from '../../app/ts/utils/websiteOrigin.js'

describe('website origin identity', () => {
	test('keeps authorization origins scheme-scoped while normalizing hosts and ports', () => {
		assert.equal(getWebsiteOrigin('http://example.test/path'), 'http://example.test')
		assert.equal(getWebsiteOrigin('https://example.test/path'), 'https://example.test')
		assert.notEqual(getWebsiteOrigin('http://example.test/path'), getWebsiteOrigin('https://example.test/path'))
		assert.equal(getWebsiteOrigin('https://example.test:443/path'), 'https://example.test')
		// The pre-upgrade host helper already removed scheme-default ports; imported explicit-port records still need rebinding support.
		assert.equal(getHostWithPort('https://example.test:443/path'), 'example.test')
		assert.equal(getHostWithPort('http://example.test:80/path'), 'example.test')
		assert.equal(getWebsiteOrigin('https://example.test:8443/path'), 'https://example.test:8443')
	})

	test('scopes file website access to the exact file path', () => {
		assert.equal(getWebsiteOrigin('file:///tmp/first.html'), 'file:///tmp/first.html')
		assert.equal(getWebsiteOrigin('file:///tmp/second.html'), 'file:///tmp/second.html')
		assert.notEqual(getWebsiteOrigin('file:///tmp/first.html'), getWebsiteOrigin('file:///tmp/second.html'))
	})
})

describe('stored website origin applicability', () => {
	test.each(storedWebsiteOriginCases)('stored %p applies to %p: %p', (storedOrigin, websiteOrigin, applies) => {
		assert.equal(doesStoredWebsiteOriginApplyTo(storedOrigin, websiteOrigin), applies)
	})
})

// Blocking uses hostname while the compatibility table deliberately preserves explicit legacy ports.
describe('stored website host interpretation', () => {
	for (const [stored, hostname, hostWithPort] of [
		['https://Example.test:443/path', 'example.test', 'example.test'],
		['http://example.test:80', 'example.test', 'example.test'],
		['https://example.test:8443', 'example.test', 'example.test:8443'],
		['example.test:80', 'example.test', 'example.test:80'],
		['example.test:443', 'example.test', 'example.test:443'],
		['example.test:8080', 'example.test', 'example.test:8080'],
		['[::1]:443', '[::1]', '[::1]:443'],
	] as const) test(`interprets ${ stored } for both hostname and port-sensitive consumers`, () => {
		assert.deepEqual(getStoredWebsiteHost(stored), { hostname, hostWithPort })
	})
	for (const stored of ['', 'file:///tmp/page.html', 'file://server/share/page.html', 'https://user:secret@example.test', 'not a host']) test(`does not derive a website host for ${ stored }`, () => {
		assert.equal(getStoredWebsiteHost(stored), undefined)
	})
})
