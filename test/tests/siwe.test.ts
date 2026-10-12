import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { getSiweDomainAsWebsiteOrigin, getSiweOriginText, looksLikeSiweMessage, parseSiweDateTime, parseSiweMessage } from '../../app/ts/utils/siwe.js'

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
		['a hexadecimal chain ID', siweMessage({ fields: REQUIRED_FIELDS.map((field) => field === 'Chain ID: 1' ? 'Chain ID: 0x1' : field) })],
		['a URI without a scheme', siweMessage({ fields: REQUIRED_FIELDS.map((field) => field.startsWith('URI: ') ? 'URI: example.com/login' : field) })],
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

describe('Sign-In with Ethereum domain normalization', () => {
	const parsedMinimalMessage = parseSiweMessage(minimalMessage)
	if (parsedMinimalMessage === undefined) throw new Error('expected the minimal message to parse')
	const withDomain = (domain: string, scheme?: string) => ({ ...parsedMinimalMessage, domain, scheme })

	test('normalizes the domain to the host and port form of website origins', () => {
		assert.equal(getSiweDomainAsWebsiteOrigin(withDomain('Example.COM')), 'example.com')
		assert.equal(getSiweDomainAsWebsiteOrigin(withDomain('example.com:443')), 'example.com')
		assert.equal(getSiweDomainAsWebsiteOrigin(withDomain('example.com:80', 'http')), 'example.com')
		assert.equal(getSiweDomainAsWebsiteOrigin(withDomain('example.com:80')), 'example.com:80')
		assert.equal(getSiweDomainAsWebsiteOrigin(withDomain('localhost:3000', 'http')), 'localhost:3000')
		assert.equal(getSiweDomainAsWebsiteOrigin(withDomain('[::1]:3000')), '[::1]:3000')
	})

	test('refuses a domain with userinfo, which can disguise the real host', () => {
		assert.equal(getSiweDomainAsWebsiteOrigin(withDomain('example.com@evil.example')), undefined)
		assert.equal(getSiweDomainAsWebsiteOrigin(withDomain('user:password@example.com')), undefined)
		assert.equal(getSiweDomainAsWebsiteOrigin(withDomain('@example.com')), undefined)
		assert.equal(getSiweDomainAsWebsiteOrigin(withDomain(':@example.com')), undefined)
	})
})
