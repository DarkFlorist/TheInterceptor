import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { doWebsiteOriginsShareHostname, getDomainMatchPatterns, getHostnameForWebsiteOrigin, isHostScopedWebsiteOrigin } from '../../app/ts/utils/websiteOrigins.js'

describe('website origin helpers', () => {
	test('extracts hostnames from stored website origins', () => {
		assert.equal(getHostnameForWebsiteOrigin('localhost:3000'), 'localhost')
		assert.equal(getHostnameForWebsiteOrigin('example.test:8545'), 'example.test')
	})

	test('creates valid MV3 match patterns without ports', () => {
		assert.deepEqual(getDomainMatchPatterns('localhost:3000'), ['*://localhost/*'])
		assert.deepEqual(getDomainMatchPatterns('example.test:8545'), ['*://example.test/*', '*://*.example.test/*'])
		assert.deepEqual(getDomainMatchPatterns('127.0.0.1:3000'), ['*://127.0.0.1/*'])
	})

	test('identifies whether a stored origin is explicitly host scoped', () => {
		assert.equal(isHostScopedWebsiteOrigin('example.test'), true)
		assert.equal(isHostScopedWebsiteOrigin('example.test:8545'), false)
	})

	test('compares origins by hostname without widening across sibling subdomains', () => {
		assert.equal(doWebsiteOriginsShareHostname('localhost:3000', 'localhost:5173'), true)
		assert.equal(doWebsiteOriginsShareHostname('one.example.test:3000', 'two.example.test:3000'), false)
	})
})
