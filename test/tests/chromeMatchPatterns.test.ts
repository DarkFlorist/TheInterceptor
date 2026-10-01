import * as assert from 'assert'
import { test } from 'bun:test'
import { getChromeMatchPatterns } from '../../app/ts/utils/chromeMatchPatterns.js'

const cases: readonly { readonly value: string, readonly exact: readonly string[], readonly site: readonly string[] }[] = [
	{ value: 'https://example.com', exact: ['https://example.com:443/*'], site: ['https://*.example.com/*'] },
	{ value: 'http://example.com:8443', exact: ['http://example.com:8443/*'], site: ['http://*.example.com:8443/*'] },
	{ value: 'https://example.com:443', exact: ['https://example.com:443/*'], site: ['https://*.example.com/*'] },
	{ value: 'example.com', exact: [], site: ['*://*.example.com/*'] },
	{ value: 'localhost:3000', exact: [], site: ['http://localhost:3000/*', 'https://localhost:3000/*'] },
	{ value: 'http://localhost', exact: ['http://localhost:80/*'], site: ['http://localhost/*'] },
	{ value: 'http://127.0.0.1:8545', exact: ['http://127.0.0.1:8545/*'], site: ['http://127.0.0.1:8545/*'] },
	{ value: 'https://[::1]', exact: ['https://[::1]:443/*'], site: ['https://[::1]/*'] },
	{ value: '[::1]:8545', exact: [], site: ['http://[::1]:8545/*', 'https://[::1]:8545/*'] },
	{ value: '', exact: [], site: ['file:///*'] },
	{ value: 'file:///', exact: [], site: ['file:///*'] },
]

test('Chrome match patterns share host/port translation while respecting exact origin and disabled-site scope', () => {
	for (const { value, exact, site } of cases) {
		assert.deepEqual(getChromeMatchPatterns(value, 'exact-origin'), exact)
		assert.deepEqual(getChromeMatchPatterns(value, 'site-with-subdomains'), site)
	}
})

test('Chrome match patterns reject invalid URL shapes in both scopes', () => {
	for (const value of ['https://*.example.com', 'https://user:password@example.com', 'https://example.com/path', 'https://example.com?query', 'https://example.com#hash', 'ftp://example.com', 'http://[broken']) {
		for (const intent of ['exact-origin', 'site-with-subdomains'] as const) assert.deepEqual(getChromeMatchPatterns(value, intent), [])
	}
})
