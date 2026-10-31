import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { getHostWithPort, getWebsiteOrigin, getWebsiteOriginForDisplay } from '../../app/ts/utils/websiteOrigin.js'

describe('website origin identity and display', () => {
	test('keeps authorization origins scheme-scoped while preserving host-style display', () => {
		assert.equal(getWebsiteOrigin('http://example.test/path'), 'http://example.test')
		assert.equal(getWebsiteOrigin('https://example.test/path'), 'https://example.test')
		assert.notEqual(getWebsiteOrigin('http://example.test/path'), getWebsiteOrigin('https://example.test/path'))
		assert.equal(getWebsiteOrigin('https://example.test:443/path'), 'https://example.test')
		// The pre-upgrade host helper already removed scheme-default ports; imported explicit-port records still need rebinding support.
		assert.equal(getHostWithPort('https://example.test:443/path'), 'example.test')
		assert.equal(getHostWithPort('http://example.test:80/path'), 'example.test')
		assert.equal(getWebsiteOrigin('https://example.test:8443/path'), 'https://example.test:8443')
		assert.equal(getWebsiteOriginForDisplay('https://example.test:8443'), 'example.test:8443')
		assert.equal(getWebsiteOriginForDisplay('example.test'), 'example.test')
	})

	test('scopes file website access to the exact file path', () => {
		assert.equal(getWebsiteOrigin('file:///tmp/first.html'), 'file:///tmp/first.html')
		assert.equal(getWebsiteOrigin('file:///tmp/second.html'), 'file:///tmp/second.html')
		assert.notEqual(getWebsiteOrigin('file:///tmp/first.html'), getWebsiteOrigin('file:///tmp/second.html'))
	})
})
