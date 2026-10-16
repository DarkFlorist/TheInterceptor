import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { getRpcFetchTarget, redactRpcUrlCredentials } from '../../app/ts/utils/rpcUrlCredentials.js'

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

	test('leaves credential-free and unparseable URLs unchanged for display', () => {
		assert.equal(redactRpcUrlCredentials('https://rpc.example'), 'https://rpc.example')
		assert.equal(redactRpcUrlCredentials('rpc example'), 'rpc example')
	})
})
