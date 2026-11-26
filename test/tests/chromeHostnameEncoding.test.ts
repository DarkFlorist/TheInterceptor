import * as assert from 'assert'
import { test } from 'bun:test'
import { getChromeMatchPatterns, isPlainUrlHostname, isWildcardUrlHostname } from '../../app/ts/utils/chromeMatchPatterns.js'

// Chrome's URL parser keeps '*' and some other host characters percent-encoded (https://*.cow.fi has hostname '%2A.cow.fi') while Bun decodes them. These tests reproduce Chrome's hostnames directly so they do not depend on the test runtime's parser.
const CHROME_PERCENT_ENCODED_HOST_CHARACTERS: Readonly<Record<string, string>> = { '*': '%2A', '!': '%21', '$': '%24', '&': '%26', '\'': '%27', '(': '%28', ')': '%29', '+': '%2B', ',': '%2C', ';': '%3B', '=': '%3D' }

function encodeHostnameLikeChrome(hostname: string) {
	return [...hostname].map((character) => CHROME_PERCENT_ENCODED_HOST_CHARACTERS[character] ?? character).join('')
}

function withChromeLikeUrlParser(run: () => void) {
	const RuntimeUrl = globalThis.URL
	const ChromeLikeUrl = new Proxy(RuntimeUrl, {
		construct: (target, args) => {
			const url = Reflect.construct(target, args)
			const chromeHostname = encodeHostnameLikeChrome(url.hostname)
			const chromeHost = url.port === '' ? chromeHostname : `${ chromeHostname }:${ url.port }`
			return new Proxy(url, {
				get: (runtimeUrl, property) => {
					if (property === 'hostname') return chromeHostname
					if (property === 'host') return chromeHost
					if (property === 'origin') return `${ runtimeUrl.protocol }//${ chromeHost }`
					return Reflect.get(runtimeUrl, property)
				},
			})
		},
	})
	globalThis.URL = ChromeLikeUrl
	try {
		run()
	} finally {
		globalThis.URL = RuntimeUrl
	}
}

test('plain URL hostnames accept DNS names, IP addresses and bracketed IPv6 only', () => {
	for (const hostname of ['example.com', 'swap.cow.fi', 'localhost', 'xn--bcher-kva.example', 'my_host.example', 'example.com.', '127.0.0.1', '[::1]', '[2001:db8::1]']) assert.equal(isPlainUrlHostname(hostname), true, hostname)
	for (const hostname of ['', '*.cow.fi', '%2A.cow.fi', '%2a.cow.fi', '%2A', 'a%21b.example', 'a%2Bb.example', '%41.example', 'EXAMPLE.com', '.example.com', 'example..com', 'exa mple.com', '[::1', 'example.com:443']) assert.equal(isPlainUrlHostname(hostname), false, hostname)
})

test('wildcard hostnames are detected in raw and Chrome percent-encoded form', () => {
	for (const hostname of ['*.cow.fi', '%2A.cow.fi', '%2a.cow.fi', '%2A', 'app.%2A.example']) assert.equal(isWildcardUrlHostname(hostname), true, hostname)
	for (const hostname of ['cow.fi', '%2B.cow.fi', 'a%21b.example']) assert.equal(isWildcardUrlHostname(hostname), false, hostname)
})

test('Chrome match patterns ignore percent-encoded and wildcard hosts in both scopes', () => {
	const rejectedHosts = ['https://*.cow.fi', 'https://%2A.cow.fi', '%2A.cow.fi', '*.cow.fi', 'https://a!b.example', 'a+b.example']
	withChromeLikeUrlParser(() => {
		assert.deepEqual(getChromeMatchPatterns('https://swap.cow.fi', 'exact-origin'), ['https://swap.cow.fi:443/*'])
		assert.deepEqual(getChromeMatchPatterns('cow.fi', 'disabled-site'), ['http://cow.fi:80/*', 'https://cow.fi:443/*'])
		for (const value of rejectedHosts) {
			for (const intent of ['exact-origin', 'disabled-site'] as const) assert.deepEqual(getChromeMatchPatterns(value, intent), [], `${ value } ${ intent }`)
		}
	})
	for (const value of rejectedHosts) {
		for (const intent of ['exact-origin', 'disabled-site'] as const) assert.deepEqual(getChromeMatchPatterns(value, intent), [], `${ value } ${ intent }`)
	}
})
