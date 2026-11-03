import * as assert from 'assert'
import { test } from 'bun:test'
import { getChromeMatchPatterns } from '../../app/ts/utils/chromeMatchPatterns.js'

const cases: readonly { readonly value: string, readonly exact: readonly string[], readonly disabledSite: readonly string[] }[] = [
	{ value: 'https://example.com', exact: ['https://example.com:443/*'], disabledSite: ['https://example.com:443/*'] },
	{ value: 'http://example.com:8443', exact: ['http://example.com:8443/*'], disabledSite: ['http://example.com:8443/*'] },
	{ value: 'http://example.com:80', exact: ['http://example.com:80/*'], disabledSite: ['http://example.com:80/*'] },
	{ value: 'https://example.com:443', exact: ['https://example.com:443/*'], disabledSite: ['https://example.com:443/*'] },
	{ value: 'example.com', exact: [], disabledSite: ['http://example.com:80/*', 'https://example.com:443/*'] },
	{ value: 'localhost:3000', exact: [], disabledSite: ['http://localhost:3000/*', 'https://localhost:3000/*'] },
	{ value: 'http://localhost', exact: ['http://localhost:80/*'], disabledSite: ['http://localhost:80/*'] },
	{ value: 'http://127.0.0.1:8545', exact: ['http://127.0.0.1:8545/*'], disabledSite: ['http://127.0.0.1:8545/*'] },
	{ value: 'https://[::1]', exact: ['https://[::1]:443/*'], disabledSite: ['https://[::1]:443/*'] },
	{ value: '[::1]:8545', exact: [], disabledSite: ['http://[::1]:8545/*', 'https://[::1]:8545/*'] },
	{ value: '', exact: [], disabledSite: ['file:///*'] },
	{ value: 'file:///', exact: [], disabledSite: ['file:///*'] },
]

test('Chrome match patterns share host/port translation while respecting exact origin and disabled-site scope', () => {
	for (const { value, exact, disabledSite } of cases) {
		assert.deepEqual(getChromeMatchPatterns(value, 'exact-origin'), exact)
		assert.deepEqual(getChromeMatchPatterns(value, 'disabled-site'), disabledSite)
	}
})

test('Chrome match patterns reject invalid URL shapes in both scopes', () => {
	for (const value of ['https://*.example.com', 'https://user:password@example.com', 'https://example.com/path', 'https://example.com?query', 'https://example.com#hash', 'ftp://example.com', 'http://[broken']) {
		for (const intent of ['exact-origin', 'disabled-site'] as const) assert.deepEqual(getChromeMatchPatterns(value, intent), [])
	}
})
