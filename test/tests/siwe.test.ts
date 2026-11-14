import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { SiweMessage } from '../../app/ts/types/personal-message-definitions.js'
import { serialize } from '../../app/ts/types/wire-types.js'
import { getFrameOrigins, getHostWithPort } from '../../app/ts/utils/requests.js'
import { getSiweLookalikeQuarantineReasons, getSiweMessageOrigin, getSiweOriginText, getSiweQuarantineReasons, getSiweValidityWarnings, looksLikeSiweMessage, parseSiweDateTime, parseSiweMessage, SIWE_LOOKALIKE_QUARANTINE_REASON } from '../../app/ts/utils/siwe.js'

const CHECKSUMMED_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const HEADER = 'example.com wants you to sign in with your Ethereum account:'
const REQUIRED_FIELDS = [
	'URI: https://example.com/login',
	'Version: 1',
	'Chain ID: 1',
	'Nonce: 32891756',
	'Issued At: 2021-09-30T16:25:24Z',
]

// Builds a message line by line so each test only spells out the part it changes.
const siweMessage = ({ header = HEADER, address = CHECKSUMMED_ADDRESS, statementLines = [''], fields = REQUIRED_FIELDS }: { header?: string, address?: string, statementLines?: readonly string[], fields?: readonly string[] } = {}) => [header, address, '', ...statementLines, ...fields].join('\n')

const minimalMessage = siweMessage()

const withChainId = (chainId: string) => siweMessage({ fields: REQUIRED_FIELDS.map((field) => field === 'Chain ID: 1' ? `Chain ID: ${ chainId }` : field) })
const withUri = (uri: string) => siweMessage({ fields: REQUIRED_FIELDS.map((field) => field.startsWith('URI: ') ? `URI: ${ uri }` : field) })
const withResource = (resource: string) => siweMessage({ fields: [...REQUIRED_FIELDS, 'Resources:', `- ${ resource }`] })

// The EIP-4361 example with an explicit scheme, extended with every optional field.
const fullMessage = siweMessage({
	header: 'https://example.com:3388 wants you to sign in with your Ethereum account:',
	statementLines: ['I accept the ExampleOrg Terms of Service: https://example.com/tos', ''],
	fields: [
		...REQUIRED_FIELDS,
		'Expiration Time: 2021-10-30T16:25:24.123+02:00',
		'Not Before: 2021-09-30T16:30:00Z',
		'Request ID: request-1@example',
		'Resources:',
		'- ipfs://bafybeiemxf5abjwjbikoz4mc3a3dla6ual3jsgpdr4cjr3oz3evfyavhwq/',
		'- https://example.com/my-web2-claim.json',
	],
})

describe('Sign-In with Ethereum message parsing', () => {
	test('parses a minimal message without a statement or optional fields', () => {
		assert.deepEqual(parseSiweMessage(minimalMessage), {
			scheme: undefined,
			domain: 'example.com',
			address: BigInt(CHECKSUMMED_ADDRESS),
			statement: undefined,
			uri: 'https://example.com/login',
			version: '1',
			chainId: 1n,
			nonce: '32891756',
			issuedAt: '2021-09-30T16:25:24Z',
			expirationTime: undefined,
			notBefore: undefined,
			requestId: undefined,
			resources: [],
		})
	})

	test('parses a message with an explicit scheme, a port, a statement and every optional field', () => {
		assert.deepEqual(parseSiweMessage(fullMessage), {
			scheme: 'https',
			domain: 'example.com:3388',
			address: BigInt(CHECKSUMMED_ADDRESS),
			statement: 'I accept the ExampleOrg Terms of Service: https://example.com/tos',
			uri: 'https://example.com/login',
			version: '1',
			chainId: 1n,
			nonce: '32891756',
			issuedAt: '2021-09-30T16:25:24Z',
			expirationTime: '2021-10-30T16:25:24.123+02:00',
			notBefore: '2021-09-30T16:30:00Z',
			requestId: 'request-1@example',
			resources: [
				'ipfs://bafybeiemxf5abjwjbikoz4mc3a3dla6ual3jsgpdr4cjr3oz3evfyavhwq/',
				'https://example.com/my-web2-claim.json',
			],
		})
	})

	test('reads the scheme only when the header names one', () => {
		const withScheme = parseSiweMessage(siweMessage({ header: 'http://localhost:3000 wants you to sign in with your Ethereum account:' }))
		const withoutScheme = parseSiweMessage(siweMessage({ header: 'localhost:3000 wants you to sign in with your Ethereum account:' }))
		assert.equal(withScheme?.scheme, 'http')
		assert.equal(withScheme?.domain, 'localhost:3000')
		assert.equal(withoutScheme?.scheme, undefined)
		assert.equal(withoutScheme?.domain, 'localhost:3000')
		if (withScheme === undefined || withoutScheme === undefined) throw new Error('expected both messages to parse')
		assert.equal(getSiweOriginText(withScheme), 'http://localhost:3000')
		assert.equal(getSiweOriginText(withoutScheme), 'localhost:3000')
	})

	test('accepts an empty statement line and an empty resource list, which the ABNF allows', () => {
		const parsed = parseSiweMessage(siweMessage({ statementLines: ['', ''], fields: [...REQUIRED_FIELDS, 'Request ID: ', 'Resources:'] }))
		assert.equal(parsed?.statement, undefined)
		assert.equal(parsed?.requestId, '')
		assert.deepEqual(parsed?.resources, [])
	})

	test('accepts an address without checksum casing but rejects a wrong EIP-55 checksum', () => {
		assert.equal(parseSiweMessage(siweMessage({ address: CHECKSUMMED_ADDRESS.toLowerCase() }))?.address, BigInt(CHECKSUMMED_ADDRESS))
		assert.equal(parseSiweMessage(siweMessage({ address: `0x${ CHECKSUMMED_ADDRESS.slice(2).toUpperCase() }` }))?.address, BigInt(CHECKSUMMED_ADDRESS))
		assert.equal(parseSiweMessage(siweMessage({ address: '0xc02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' })), undefined)
	})

	const malformedMessages: readonly (readonly [string, string])[] = [
		['a single blank line after the address without a statement', [HEADER, CHECKSUMMED_ADDRESS, '', ...REQUIRED_FIELDS].join('\n')],
		['a statement spread over two lines', siweMessage({ statementLines: ['First line', 'Second line', ''] })],
		['a statement with a character outside RFC 3986', siweMessage({ statementLines: ['Sign in to "Example"', ''] })],
		['a statement with non-ASCII text', siweMessage({ statementLines: ['Kirjaudu sisään', ''] })],
		['a missing blank line after the statement', siweMessage({ statementLines: ['I accept the terms'] })],
		['optional fields out of order', siweMessage({ fields: [...REQUIRED_FIELDS, 'Not Before: 2021-09-30T16:30:00Z', 'Expiration Time: 2021-10-30T16:25:24Z'] })],
		['a missing nonce', siweMessage({ fields: REQUIRED_FIELDS.filter((field) => !field.startsWith('Nonce: ')) })],
		['a nonce shorter than eight characters', siweMessage({ fields: REQUIRED_FIELDS.map((field) => field.startsWith('Nonce: ') ? 'Nonce: 1234567' : field) })],
		['an unsupported version', siweMessage({ fields: REQUIRED_FIELDS.map((field) => field === 'Version: 1' ? 'Version: 2' : field) })],
		['a field tag in the wrong case', siweMessage({ fields: REQUIRED_FIELDS.map((field) => field.replace('URI: ', 'uri: ')) })],
		['a hexadecimal chain ID', withChainId('0x1')],
		['a chain ID of 2^256, which the stored message cannot hold', withChainId((2n ** 256n).toString())],
		['a URI without a scheme', withUri('example.com/login')],
		['a URI with a port that is not a number', withUri('https://example.com:abc/login')],
		['a URI with a bracketed host that is not an IP address', withUri('https://[not-an-ip]/login')],
		['a URI with a bracketed host made of IPv6 characters that is not an IPv6 address', withUri('https://[abc]/login')],
		['a URI with brackets outside its host', withUri('https://example.com/login[1]')],
		['a resource with a port that is not a number', withResource('https://example.com:abc/claim.json')],
		['a resource with a bracketed host that is not an IP address', withResource('https://[not-an-ip]/claim.json')],
		['an impossible date', siweMessage({ fields: REQUIRED_FIELDS.map((field) => field.startsWith('Issued At: ') ? 'Issued At: 2021-02-30T16:25:24Z' : field) })],
		['a date with a space instead of "T"', siweMessage({ fields: REQUIRED_FIELDS.map((field) => field.startsWith('Issued At: ') ? 'Issued At: 2021-09-30 16:25:24Z' : field) })],
		['an unknown field', siweMessage({ fields: [...REQUIRED_FIELDS, 'Wallet: anything'] })],
		['a resource without the "- " prefix', siweMessage({ fields: [...REQUIRED_FIELDS, 'Resources:', 'https://example.com/claim.json'] })],
		['a domain with a path', siweMessage({ header: 'example.com/login wants you to sign in with your Ethereum account:' })],
		['a percent-encoded domain, which would be compared decoded but shown encoded', siweMessage({ header: '%65vil.example wants you to sign in with your Ethereum account:' })],
		['text before the domain', siweMessage({ header: 'Hello! example.com wants you to sign in with your Ethereum account:' })],
		['a trailing line break', `${ minimalMessage }\n`],
		['CRLF line endings', minimalMessage.replaceAll('\n', '\r\n')],
		['a missing address', [HEADER, '', '', ...REQUIRED_FIELDS].join('\n')],
	]
	for (const [description, message] of malformedMessages) {
		test(`leaves a message with ${ description } unparsed but recognizes it as a sign-in look-alike`, () => {
			assert.equal(parseSiweMessage(message), undefined)
			assert.equal(looksLikeSiweMessage(message), true)
		})
	}

	test('accepts the URI forms sign-in messages use, both as the URI and as a resource', () => {
		for (const uri of [
			'https://example.com',
			'http://localhost:3000/login',
			'https://user@example.com:3388/login?next=%2F&lang=en#top',
			'https://[2001:db8::1]:8443/login',
			'ipfs://bafybeiemxf5abjwjbikoz4mc3a3dla6ual3jsgpdr4cjr3oz3evfyavhwq/',
			'did:pkh:eip155:1:0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
			'urn:recap:eyJhdHQiOnsiaHR0cHM6Ly9leGFtcGxlLmNvbSI6e319fQ',
			'mailto:user@example.com',
		]) {
			assert.equal(parseSiweMessage(withUri(uri))?.uri, uri, uri)
			assert.deepEqual(parseSiweMessage(withResource(uri))?.resources, [uri], uri)
		}
	})

	test('parses the largest chain ID the stored message can hold, and the result serializes', () => {
		const parsed = parseSiweMessage(withChainId((2n ** 256n - 1n).toString()))
		if (parsed === undefined) throw new Error('expected a chain ID of 2^256 - 1 to parse')
		assert.equal(parsed.chainId, 2n ** 256n - 1n)
		assert.deepEqual(SiweMessage.parse(serialize(SiweMessage, parsed)), parsed)
	})

	test('leaves ordinary messages unparsed and does not mistake them for sign-in messages', () => {
		for (const message of ['', 'hello', 'Please sign in to continue', '{"action":"login","account":"0x1"}', 'Sign this message to prove you own your Ethereum account']) {
			assert.equal(parseSiweMessage(message), undefined)
			assert.equal(looksLikeSiweMessage(message), false)
		}
	})

	test('recognizes the sign-in phrase regardless of case and spacing', () => {
		assert.equal(looksLikeSiweMessage('evil.example wants you to sign in with your Ethereum account'), true)
		assert.equal(looksLikeSiweMessage('EXAMPLE.COM WANTS YOU TO SIGN IN WITH YOUR ETHEREUM ACCOUNT:'), true)
		assert.equal(looksLikeSiweMessage('example.com wants you to  sign in\twith your Ethereum\naccount:'), true)
	})
})

describe('Sign-In with Ethereum date-times', () => {
	test('parses RFC 3339 date-times with offsets, fractions and lower case separators', () => {
		assert.equal(parseSiweDateTime('2021-09-30T16:25:24Z')?.toISOString(), '2021-09-30T16:25:24.000Z')
		assert.equal(parseSiweDateTime('2021-09-30T16:25:24.123456+02:00')?.toISOString(), '2021-09-30T14:25:24.123Z')
		assert.equal(parseSiweDateTime('2021-09-30T16:25:24-01:30')?.toISOString(), '2021-09-30T17:55:24.000Z')
		assert.equal(parseSiweDateTime('2021-09-30t16:25:24z')?.toISOString(), '2021-09-30T16:25:24.000Z')
		assert.equal(parseSiweDateTime('2024-02-29T00:00:00Z')?.toISOString(), '2024-02-29T00:00:00.000Z')
		assert.equal(parseSiweDateTime('0099-01-01T00:00:00Z')?.toISOString(), '0099-01-01T00:00:00.000Z')
	})

	test('rejects date-times that are not RFC 3339 or name an impossible time', () => {
		for (const text of ['2023-02-29T00:00:00Z', '2021-04-31T00:00:00Z', '2021-13-01T00:00:00Z', '2021-09-30T24:00:00Z', '2021-09-30T16:25:24', '2021-9-30T16:25:24Z', '2021-09-30T16:25:24+0200', '1633019124']) {
			assert.equal(parseSiweDateTime(text), undefined, text)
		}
	})
})

describe('Sign-In with Ethereum validity window', () => {
	const parsedMinimalMessage = parseSiweMessage(minimalMessage)
	if (parsedMinimalMessage === undefined) throw new Error('expected the minimal message to parse')
	const now = new Date('2026-01-01T00:05:00Z')

	test('warns about an expired sign-in message and one that is not valid yet', () => {
		assert.deepEqual(getSiweValidityWarnings({ ...parsedMinimalMessage, expirationTime: '2026-01-01T00:04:59Z' }, now), ['This sign-in message expired at 2026-01-01T00:04:59.000Z.'])
		assert.deepEqual(getSiweValidityWarnings({ ...parsedMinimalMessage, notBefore: '2026-01-01T01:00:00+00:00' }, now), ['This sign-in message is not valid until 2026-01-01T01:00:00.000Z, so signing it now gives the website a sign-in it can use later.'])
	})

	test('treats the expiration time as already expired and the not-before time as already valid', () => {
		assert.deepEqual(getSiweValidityWarnings({ ...parsedMinimalMessage, expirationTime: '2026-01-01T00:05:00Z' }, now), ['This sign-in message expired at 2026-01-01T00:05:00.000Z.'])
		assert.deepEqual(getSiweValidityWarnings({ ...parsedMinimalMessage, notBefore: '2026-01-01T00:05:00Z' }, now), [])
	})

	test('does not warn about a sign-in message inside its validity window or without one', () => {
		assert.deepEqual(getSiweValidityWarnings({ ...parsedMinimalMessage, expirationTime: '2026-01-01T00:10:00Z', notBefore: '2026-01-01T00:04:00Z' }, now), [])
		assert.deepEqual(getSiweValidityWarnings(parsedMinimalMessage, now), [])
	})
})

describe('requesting frame origins', () => {
	test('derives the website origin and the request origin of a frame from one URL, with the same host and port', () => {
		for (const [frameUrl, websiteOrigin, requestOrigin] of [
			['https://Example.COM/login?next=%2F#top', 'example.com', 'https://example.com'],
			['https://example.com:443/', 'example.com', 'https://example.com'],
			['https://example.com:8443/app', 'example.com:8443', 'https://example.com:8443'],
			['http://localhost:3000/login', 'localhost:3000', 'http://localhost:3000'],
			['http://[::1]:3000/', '[::1]:3000', 'http://[::1]:3000'],
		] as const) {
			const origins = getFrameOrigins(frameUrl)
			assert.deepEqual(origins, { websiteOrigin, requestOrigin }, frameUrl)
			// The website origin is exactly what the rest of the extension keys website access by, and the request origin only adds the scheme to it.
			assert.equal(origins.websiteOrigin, getHostWithPort(frameUrl), frameUrl)
			assert.equal(origins.requestOrigin, `${ new URL(frameUrl).protocol }//${ origins.websiteOrigin }`, frameUrl)
		}
	})
})

describe('Sign-In with Ethereum origin normalization', () => {
	const parsedMinimalMessage = parseSiweMessage(minimalMessage)
	if (parsedMinimalMessage === undefined) throw new Error('expected the minimal message to parse')
	const withDomain = (domain: string, scheme?: string) => ({ ...parsedMinimalMessage, domain, scheme })

	test('normalizes the message origin the way the origin of a requesting frame is recorded', () => {
		assert.equal(getSiweMessageOrigin(withDomain('Example.COM')), 'https://example.com')
		assert.equal(getSiweMessageOrigin(withDomain('example.com', 'HTTPS')), 'https://example.com')
		assert.equal(getSiweMessageOrigin(withDomain('example.com:443')), 'https://example.com')
		assert.equal(getSiweMessageOrigin(withDomain('example.com:80', 'http')), 'http://example.com')
		assert.equal(getSiweMessageOrigin(withDomain('example.com:80')), 'https://example.com:80')
		assert.equal(getSiweMessageOrigin(withDomain('localhost:3000', 'http')), 'http://localhost:3000')
		assert.equal(getSiweMessageOrigin(withDomain('[::1]:3000')), 'https://[::1]:3000')
		for (const frameUrl of ['https://Example.COM:443/login?next=%2F', 'http://localhost:3000/', 'https://[::1]:3000/app']) {
			const frameOrigin = getFrameOrigins(frameUrl).requestOrigin
			const [scheme, domain] = frameOrigin.split('://')
			if (scheme === undefined || domain === undefined) throw new Error(`unexpected origin ${ frameOrigin }`)
			assert.equal(getSiweMessageOrigin(withDomain(domain, scheme)), frameOrigin, frameUrl)
		}
	})

	test('refuses a domain with userinfo, which can disguise the real host', () => {
		assert.equal(getSiweMessageOrigin(withDomain('example.com@evil.example')), undefined)
		assert.equal(getSiweMessageOrigin(withDomain('user:password@example.com')), undefined)
		assert.equal(getSiweMessageOrigin(withDomain('@example.com')), undefined)
		assert.equal(getSiweMessageOrigin(withDomain(':@example.com')), undefined)
	})
})

describe('Sign-In with Ethereum website check', () => {
	const parsedMinimalMessage = parseSiweMessage(minimalMessage)
	if (parsedMinimalMessage === undefined) throw new Error('expected the minimal message to parse')
	const fromEvilExample = 'This sign-in message is for https://example.com, but it was requested by https://evil.example. A website asking you to sign in to a different website is a common phishing attack.'

	test('does not flag a sign-in message from the origin it names', () => {
		assert.deepEqual(getSiweQuarantineReasons(parsedMinimalMessage, 'https://example.com'), [])
		assert.deepEqual(getSiweQuarantineReasons({ ...parsedMinimalMessage, scheme: 'https', domain: 'EXAMPLE.com:443' }, 'https://example.com'), [])
		assert.deepEqual(getSiweQuarantineReasons({ ...parsedMinimalMessage, scheme: 'http', domain: 'localhost:3000' }, 'http://localhost:3000'), [])
	})

	test('flags a sign-in message for a different website as phishing', () => {
		assert.deepEqual(getSiweQuarantineReasons(parsedMinimalMessage, 'https://evil.example'), [fromEvilExample])
	})

	test('compares hosts and ports exactly, so subdomains, parent domains and other ports do not match', () => {
		for (const requestOrigin of ['https://app.example.com', 'https://com', 'https://example.com:8443', 'https://example.com.evil.example']) {
			assert.equal(getSiweQuarantineReasons(parsedMinimalMessage, requestOrigin).length, 1, requestOrigin)
		}
		assert.equal(getSiweQuarantineReasons({ ...parsedMinimalMessage, domain: 'app.example.com' }, 'https://example.com').length, 1)
	})

	test('flags a domain that hides the real host behind userinfo', () => {
		for (const domain of ['example.com@evil.example', '@evil.example', ':@evil.example']) {
			assert.equal(getSiweQuarantineReasons({ ...parsedMinimalMessage, domain }, 'https://evil.example').length, 1, domain)
		}
	})

	test('flags a scheme mismatch, assuming https when the message names no scheme', () => {
		assert.deepEqual(getSiweQuarantineReasons(parsedMinimalMessage, 'http://example.com'), [
			'This sign-in message is for https://example.com (a sign-in message that names no scheme is for https), but it was requested by http://example.com. A website asking you to sign in to a different website is a common phishing attack.',
		])
		assert.deepEqual(getSiweQuarantineReasons({ ...parsedMinimalMessage, scheme: 'http' }, 'https://example.com'), [
			'This sign-in message is for http://example.com, but it was requested by https://example.com. A website asking you to sign in to a different website is a common phishing attack.',
		])
	})

	test('flags a sign-in message whose request has no recorded origin instead of comparing hosts alone', () => {
		for (const [message, messageOrigin] of [[parsedMinimalMessage, 'https://example.com'], [{ ...parsedMinimalMessage, scheme: 'http' }, 'http://example.com']] as const) {
			assert.deepEqual(getSiweQuarantineReasons(message, undefined), [
				`This sign-in message is for ${ messageOrigin }, but the Interceptor did not record the full origin of the website that requested it, so it cannot check that they match.`,
			])
		}
	})

	test('leaves the validity window to the dialog, which checks it against the clock while it is shown', () => {
		assert.deepEqual(getSiweQuarantineReasons({ ...parsedMinimalMessage, expirationTime: '2000-01-01T00:00:00Z', notBefore: '2100-01-01T00:00:00Z' }, 'https://example.com'), [])
	})

	test('flags only unparsed messages that still read like a sign-in request', () => {
		assert.deepEqual(getSiweLookalikeQuarantineReasons(`${ minimalMessage }\n`), [SIWE_LOOKALIKE_QUARANTINE_REASON])
		assert.deepEqual(getSiweLookalikeQuarantineReasons('Welcome! Sign this message to continue.'), [])
	})
})
