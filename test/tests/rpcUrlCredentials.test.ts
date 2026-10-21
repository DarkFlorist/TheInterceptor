import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { getRpcFetchTarget, getRpcUrlCredentialsTransportError, redactRpcUrlCredentials, removeRpcUrlCredentials } from '../../app/ts/utils/rpcUrlCredentials.js'

const basicAuthorization = (credentials: string) => ({ Authorization: `Basic ${ Buffer.from(credentials, 'utf8').toString('base64') }` })

describe('RPC URL credentials', () => {
	test('returns credential-free and unparseable URLs unchanged without headers', () => {
		assert.deepEqual(getRpcFetchTarget('https://rpc.example'), { url: 'https://rpc.example', headers: {} })
		assert.deepEqual(getRpcFetchTarget('https://rpc.example/v1?key=value'), { url: 'https://rpc.example/v1?key=value', headers: {} })
		assert.deepEqual(getRpcFetchTarget('rpc example'), { url: 'rpc example', headers: {} })
	})

	test('moves username and password into a Basic authorization header', () => {
		assert.deepEqual(getRpcFetchTarget('https://alice:s3cret@rpc.example/v1?key=value'), {
			url: 'https://rpc.example/v1?key=value',
			headers: basicAuthorization('alice:s3cret'),
		})
	})

	test('keeps the scheme and port of local http nodes', () => {
		assert.deepEqual(getRpcFetchTarget('http://alice:s3cret@localhost:8545'), {
			url: 'http://localhost:8545/',
			headers: basicAuthorization('alice:s3cret'),
		})
		assert.deepEqual(getRpcFetchTarget('http://alice:s3cret@127.1.2.3:8545'), { url: 'http://127.1.2.3:8545/', headers: basicAuthorization('alice:s3cret') })
		assert.deepEqual(getRpcFetchTarget('http://alice:s3cret@[::1]:8545'), { url: 'http://[::1]:8545/', headers: basicAuthorization('alice:s3cret') })
	})

	test('throws instead of sending credentials over plaintext http to a remote host', () => {
		const expectedMessage = 'Credentials in RPC URL http://***@remote-node:8545/ can only be sent over https, or over http to localhost.'
		assert.throws(() => getRpcFetchTarget('http://alice:s3cret@remote-node:8545'), (error: unknown) => error instanceof Error && error.message === expectedMessage)
		assert.throws(() => getRpcFetchTarget('http://alice:s3cret@127.evil.com'), (error: unknown) => error instanceof Error && error.message === 'Credentials in RPC URL http://***@127.evil.com/ can only be sent over https, or over http to localhost.')
		assert.throws(() => getRpcFetchTarget('http://token@localhost.evil.com'), (error: unknown) => error instanceof Error && !error.message.includes('token'))
	})

	test('keeps credential-free plaintext http URLs to remote hosts unchanged', () => {
		assert.deepEqual(getRpcFetchTarget('http://remote-node:8545'), { url: 'http://remote-node:8545', headers: {} })
		assert.equal(getRpcUrlCredentialsTransportError('http://remote-node:8545'), undefined)
	})

	test('explains which credential URLs cannot be sent without exposing the credentials', () => {
		assert.equal(getRpcUrlCredentialsTransportError('http://alice:s3cret@remote-node:8545'), 'Credentials in RPC URL http://***@remote-node:8545/ can only be sent over https, or over http to localhost.')
		assert.equal(getRpcUrlCredentialsTransportError('https://alice:s3cret@remote-node'), undefined)
		assert.equal(getRpcUrlCredentialsTransportError('http://alice:s3cret@localhost:8545'), undefined)
		assert.equal(getRpcUrlCredentialsTransportError('rpc example'), undefined)
	})

	test('supports a username without a password and a password without a username', () => {
		assert.deepEqual(getRpcFetchTarget('https://token@rpc.example'), { url: 'https://rpc.example/', headers: basicAuthorization('token:') })
		assert.deepEqual(getRpcFetchTarget('https://:s3cret@rpc.example'), { url: 'https://rpc.example/', headers: basicAuthorization(':s3cret') })
	})

	test('decodes percent-encoded credentials', () => {
		assert.deepEqual(getRpcFetchTarget('https://us%40er:p%3Ass%2Fw%25rd%20@rpc.example').headers, basicAuthorization('us@er:p:ss/w%rd '))
		assert.deepEqual(getRpcFetchTarget('https://alice:p%C3%A4ss@rpc.example').headers, basicAuthorization('alice:päss'))
	})

	test('decodes an encoded colon in the username like browsers, so servers split credentials at the first colon', () => {
		assert.deepEqual(getRpcFetchTarget('https://us%3Aer:pw@rpc.example').headers, basicAuthorization('us:er:pw'))
	})

	test('keeps malformed percent escapes literal', () => {
		assert.deepEqual(getRpcFetchTarget('https://alice:100%zz%4@rpc.example').headers, basicAuthorization('alice:100%zz%4'))
	})

	test('encodes unicode credentials as UTF-8', () => {
		assert.deepEqual(getRpcFetchTarget('https://jürgen:pässwörd🔑@rpc.example').headers, basicAuthorization('jürgen:pässwörd🔑'))
	})

	test('redacts the whole userinfo for display', () => {
		assert.equal(redactRpcUrlCredentials('https://alice:s3cret@rpc.example/v1?key=value'), 'https://***@rpc.example/v1?key=value')
		assert.equal(redactRpcUrlCredentials('https://token@rpc.example'), 'https://***@rpc.example/')
		assert.equal(redactRpcUrlCredentials('https://:s3cret@rpc.example'), 'https://***@rpc.example/')
		assert.equal(redactRpcUrlCredentials('http://alice:p%C3%A4ss@localhost:8545'), 'http://***@localhost:8545/')
	})

	test('removes the whole userinfo for export, leaving a usable credential-free URL', () => {
		assert.equal(removeRpcUrlCredentials('https://alice:s3cret@rpc.example/v1?key=value'), 'https://rpc.example/v1?key=value')
		assert.equal(removeRpcUrlCredentials('https://token@rpc.example'), 'https://rpc.example/')
		assert.equal(removeRpcUrlCredentials('http://:s3cret@localhost:8545'), 'http://localhost:8545/')
		assert.equal(removeRpcUrlCredentials('https://rpc.example'), 'https://rpc.example')
		assert.equal(removeRpcUrlCredentials('rpc example'), 'rpc example')
	})

	test('leaves credential-free and unparseable URLs unchanged for display', () => {
		assert.equal(redactRpcUrlCredentials('https://rpc.example'), 'https://rpc.example')
		assert.equal(redactRpcUrlCredentials('rpc example'), 'rpc example')
	})
})

describe('RPC URL credential transport', () => {
	// The transport predicate is internal, so each host is checked through the exported validation entry point with test credentials added.
	const canSendCredentialsTo = (url: string) => {
		const urlWithCredentials = new URL(url)
		urlWithCredentials.username = 'alice'
		urlWithCredentials.password = 's3cret'
		return getRpcUrlCredentialsTransportError(urlWithCredentials.toString()) === undefined
	}

	test('allows credentials over https to any host', () => {
		assert.equal(canSendCredentialsTo('https://alice:s3cret@remote-node'), true)
		assert.equal(canSendCredentialsTo('https://alice:s3cret@203.0.113.7:8545'), true)
	})

	test('allows credentials over plaintext http only to loopback hosts', () => {
		for (const url of ['http://localhost:8545', 'http://LocalHost', 'http://127.0.0.1:8545', 'http://127.1.2.3', 'http://127.255.255.255', 'http://[::1]:8545']) {
			assert.equal(canSendCredentialsTo(url), true, url)
		}
	})

	test('treats IPv4 and IPv6 shorthands as the loopback addresses the URL parser normalizes them to', () => {
		assert.equal(canSendCredentialsTo('http://127.1'), true)
		assert.equal(canSendCredentialsTo('http://0x7f.1'), true)
		assert.equal(canSendCredentialsTo('http://[0:0:0:0:0:0:0:1]'), true)
	})

	test('rejects plaintext http to remote hosts, including names that only look like loopback', () => {
		for (const url of ['http://remote-node:8545', 'http://203.0.113.7', 'http://128.0.0.1', 'http://127.evil.com', 'http://localhost.evil.com', 'http://evil-localhost', 'http://127.0.0.1.nip.io']) {
			assert.equal(canSendCredentialsTo(url), false, url)
		}
	})

	test('rejects schemes other than http and https', () => {
		assert.equal(canSendCredentialsTo('ws://localhost:8545'), false)
		assert.equal(canSendCredentialsTo('ftp://localhost'), false)
	})
})

describe('RPC URL strings the URL parser cannot split into userinfo and host', () => {
	const malformedCredentialRpcUrls = [
		{ description: 'a malformed port', rpcUrl: 'https://alice:s3cret@rpc.example:99999/v1', redacted: 'https://***@rpc.example:99999/v1', removed: 'https://rpc.example:99999/v1' },
		{ description: 'a malformed host', rpcUrl: 'https://alice:s3cret@rpc exa.mple/v1', redacted: 'https://***@rpc exa.mple/v1', removed: 'https://rpc exa.mple/v1' },
		{ description: 'an @ in the path and query', rpcUrl: 'https://alice:s3cret@rpc.example:99999/team@v1?contact=ops@example.com', redacted: 'https://***@example.com', removed: 'https://example.com' },
		{ description: 'a missing scheme', rpcUrl: 'alice:s3cret@rpc.example/v1', redacted: '***@rpc.example/v1', removed: 'rpc.example/v1' },
		{ description: 'a password containing / and @', rpcUrl: 'https://alice:s3c/r@t@rpc.example:99999', redacted: 'https://***@rpc.example:99999', removed: 'https://rpc.example:99999' },
	]
	const assertNoSecret = (value: string, description: string) => {
		assert.equal(value.includes('alice'), false, description)
		assert.equal(value.includes('s3c'), false, description)
	}

	test('redacts everything up to the last @ for display', () => {
		for (const { description, rpcUrl, redacted } of malformedCredentialRpcUrls) {
			assert.equal(redactRpcUrlCredentials(rpcUrl), redacted, description)
			assertNoSecret(redactRpcUrlCredentials(rpcUrl), description)
		}
	})

	test('removes everything up to the last @ for export', () => {
		for (const { description, rpcUrl, removed } of malformedCredentialRpcUrls) {
			assert.equal(removeRpcUrlCredentials(rpcUrl), removed, description)
			assertNoSecret(removeRpcUrlCredentials(rpcUrl), description)
		}
	})

	test('refuses to fetch them, since browsers repeat the raw URL in fetch errors', () => {
		for (const { description, rpcUrl, redacted } of malformedCredentialRpcUrls) {
			const expectedMessage = `RPC URL ${ redacted } could not be parsed as a URL with a host. Check its scheme, host, and port.`
			assert.equal(getRpcUrlCredentialsTransportError(rpcUrl), expectedMessage, description)
			assert.throws(() => getRpcFetchTarget(rpcUrl), (error: unknown) => error instanceof Error && error.message === expectedMessage, description)
		}
	})

	test('leaves valid URLs with an @ after the host, and strings without any @, unchanged', () => {
		for (const rpcUrl of ['https://rpc.example/v1?contact=ops@example.com', 'rpc.example:8545', 'rpc example']) {
			assert.equal(redactRpcUrlCredentials(rpcUrl), rpcUrl)
			assert.equal(removeRpcUrlCredentials(rpcUrl), rpcUrl)
			assert.equal(getRpcUrlCredentialsTransportError(rpcUrl), undefined)
			assert.deepEqual(getRpcFetchTarget(rpcUrl), { url: rpcUrl, headers: {} })
		}
	})
})
