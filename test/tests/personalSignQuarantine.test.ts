import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { getSigningQuarantineCodes, getSiweQuarantineReasons } from '../../app/ts/background/windows/personalSign.js'
import type { SiweMessage } from '../../app/ts/types/personal-message-definitions.js'
import { decodePersonalSignMessage } from '../../app/ts/utils/personalSignMessage.js'

const siweMessage: SiweMessage = {
	scheme: undefined,
	domain: 'example.com',
	address: 0xd8da6bf26964af9d7eed9e03e53415d37aa96045n,
	statement: undefined,
	uri: 'https://example.com/login',
	version: '1',
	chainId: 1n,
	nonce: '32891756',
	issuedAt: '2026-01-01T00:00:00Z',
	expirationTime: undefined,
	notBefore: undefined,
	requestId: undefined,
	resources: [],
}
const now = new Date('2026-01-01T00:05:00Z')
const fromExampleCom = { websiteOrigin: 'example.com', websiteScheme: 'https' }

describe('personal sign quarantine checks', () => {
	test('only decodes complete 0x-prefixed byte strings', () => {
		assert.equal(decodePersonalSignMessage('0x6869'), 'hi')
		assert.equal(decodePersonalSignMessage('6869'), '6869')
		assert.equal(decodePersonalSignMessage('0xabc'), '0xabc')
	})
	test('quarantines an account mismatch when the signed message has no chain ID', () => {
		assert.deepEqual(getSigningQuarantineCodes(undefined, 1n, 0x1n, 0x2n, undefined), {
			quarantine: true,
			quarantineReasons: ['The signature request is for an account that is different from your active address.'],
		})
	})

	test('does not quarantine a matching account solely because the message has no chain ID', () => {
		assert.deepEqual(getSigningQuarantineCodes(undefined, 1n, 0x1n, 0x1n, undefined), {
			quarantine: false,
			quarantineReasons: [],
		})
	})
})

describe('Sign-In with Ethereum quarantine checks', () => {
	test('does not flag a sign-in message from the website it names', () => {
		assert.deepEqual(getSiweQuarantineReasons(siweMessage, fromExampleCom, now), [])
		assert.deepEqual(getSiweQuarantineReasons({ ...siweMessage, scheme: 'https', domain: 'EXAMPLE.com:443' }, fromExampleCom, now), [])
		assert.deepEqual(getSiweQuarantineReasons({ ...siweMessage, scheme: 'http', domain: 'localhost:3000' }, { websiteOrigin: 'localhost:3000', websiteScheme: 'http' }, now), [])
	})

	test('flags a sign-in message for a different website as phishing', () => {
		assert.deepEqual(getSiweQuarantineReasons(siweMessage, { websiteOrigin: 'evil.example', websiteScheme: 'https' }, now), [
			'This sign-in message is for https://example.com, but it was requested by https://evil.example. A website asking you to sign in to a different website is a common phishing attack.',
		])
	})

	test('compares hosts and ports exactly, so subdomains, parent domains and other ports do not match', () => {
		for (const websiteOrigin of ['app.example.com', 'com', 'example.com:8443', 'example.com.evil.example']) {
			assert.equal(getSiweQuarantineReasons(siweMessage, { websiteOrigin, websiteScheme: 'https' }, now).length, 1, websiteOrigin)
		}
		assert.equal(getSiweQuarantineReasons({ ...siweMessage, domain: 'app.example.com' }, fromExampleCom, now).length, 1)
	})

	test('flags a domain that hides the real host behind userinfo', () => {
		for (const domain of ['example.com@evil.example', '@evil.example', ':@evil.example']) {
			assert.equal(getSiweQuarantineReasons({ ...siweMessage, domain }, { websiteOrigin: 'evil.example', websiteScheme: 'https' }, now).length, 1, domain)
		}
	})

	test('flags a scheme mismatch, assuming https when the message names no scheme', () => {
		assert.deepEqual(getSiweQuarantineReasons(siweMessage, { websiteOrigin: 'example.com', websiteScheme: 'http' }, now), [
			'This sign-in message is for https://example.com (a sign-in message that names no scheme is for https), but it was requested by http://example.com. A website asking you to sign in to a different website is a common phishing attack.',
		])
		assert.equal(getSiweQuarantineReasons({ ...siweMessage, scheme: 'http' }, fromExampleCom, now).length, 1)
	})

	test('only compares the domain when the scheme of the requesting frame is unknown', () => {
		assert.deepEqual(getSiweQuarantineReasons({ ...siweMessage, scheme: 'http' }, { websiteOrigin: 'example.com', websiteScheme: undefined }, now), [])
		assert.deepEqual(getSiweQuarantineReasons(siweMessage, { websiteOrigin: 'evil.example', websiteScheme: undefined }, now), [
			'This sign-in message is for https://example.com, but it was requested by evil.example. A website asking you to sign in to a different website is a common phishing attack.',
		])
	})

	test('flags an expired sign-in message and one that is not valid yet', () => {
		assert.deepEqual(getSiweQuarantineReasons({ ...siweMessage, expirationTime: '2026-01-01T00:04:59Z' }, fromExampleCom, now), ['This sign-in message expired at 2026-01-01T00:04:59.000Z.'])
		assert.deepEqual(getSiweQuarantineReasons({ ...siweMessage, notBefore: '2026-01-01T01:00:00+00:00' }, fromExampleCom, now), ['This sign-in message is not valid until 2026-01-01T01:00:00.000Z, so signing it now gives the website a sign-in it can use later.'])
	})

	test('accepts a sign-in message inside its validity window', () => {
		assert.deepEqual(getSiweQuarantineReasons({ ...siweMessage, expirationTime: '2026-01-01T00:10:00Z', notBefore: '2026-01-01T00:05:00Z' }, fromExampleCom, now), [])
	})
})
