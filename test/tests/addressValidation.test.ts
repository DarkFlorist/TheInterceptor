import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { getIssueWithAddressString, getIssueWithUserEnteredAddress, parseUserEnteredAddress, removeEip3770ChainShortNameFromSearchQuery } from '../../app/ts/utils/addressValidation.js'

const checksummedAddress = '0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B'
const checksummedAddressHexDigits = checksummedAddress.slice(2)
const badChecksumAddress = '0xaB5801a7D398351b8bE11C439e05C5B3259aeC9B'
const addressValue = 0xab5801a7d398351b8be11c439e05c5b3259aec9bn
const otherAddress = '0x0000000000000000000000000000000000000123'
const chainPrefixIssue = 'Chain prefix must be an EIP-3770 short name followed directly by the address (e.g. eth:0x...).'

// Prefixes that read like an address or other hex data. If any of them were dropped as a chain short name, `<prefix>:<otherAddress>` would show a known address first and resolve to `otherAddress`.
const addressLikeChainPrefixes = [
	checksummedAddress,
	checksummedAddress.toLowerCase(),
	`0X${ checksummedAddressHexDigits }`,
	`0X${ checksummedAddressHexDigits.toLowerCase() }`,
	`0X${ checksummedAddressHexDigits.toUpperCase() }`,
	checksummedAddressHexDigits,
	checksummedAddressHexDigits.toLowerCase(),
	checksummedAddressHexDigits.toUpperCase(),
	'0x',
	'0X',
	'0xAb58',
	'0XAB58',
	'0xab58g',
	checksummedAddressHexDigits.slice(0, 32),
	`${ checksummedAddressHexDigits.slice(0, 31) }g`,
	`g${ checksummedAddressHexDigits.slice(0, 6) }`,
]

describe('address validation', () => {
	test('accepts uniformly uppercase addresses while still checking mixed-case addresses', () => {
		assert.equal(getIssueWithAddressString('0xDE709F2102306220921060314715629080E2FB77'), undefined)
		assert.match(getIssueWithAddressString('0x5A384227B65FA093DEC03EC34e111Db80A040615') ?? '', /Bad address checksum/u)
	})
})

describe('parseUserEnteredAddress', () => {
	test('parses plain addresses', () => {
		assert.equal(parseUserEnteredAddress(checksummedAddress), addressValue)
		assert.equal(parseUserEnteredAddress(checksummedAddress.toLowerCase()), addressValue)
		assert.equal(parseUserEnteredAddress(undefined), undefined)
	})

	test('parses EIP-3770 chain-specific addresses', () => {
		assert.equal(parseUserEnteredAddress(`eth:${ checksummedAddress }`), addressValue)
		assert.equal(parseUserEnteredAddress(`gno:${ checksummedAddress.toLowerCase() }`), addressValue)
		assert.equal(parseUserEnteredAddress(`arb1:${ checksummedAddress }`), addressValue)
		assert.equal(parseUserEnteredAddress(`base-sep:${ checksummedAddress }`), addressValue)
	})

	test('accepts the ethereum-lists/chains short-name forms in use', () => {
		const registryShortNames = [
			'oeth',
			'matic',
			'lightlink_phoenix',
			'tacchain_239-1',
			'_old_fire',
			'OP',
			'TelosEVM',
			// Short names made only of hex digits stay valid while they are too short to read like an address.
			'b3',
			'dc',
			'dffc',
			// The longest run of hex digits in a registry short name (`babea`).
			'Bobabeam',
			'thebinaryholdings-mainnet',
		]
		for (const shortName of registryShortNames) {
			assert.equal(parseUserEnteredAddress(`${ shortName }:${ checksummedAddress }`), addressValue, shortName)
		}
		assert.equal(parseUserEnteredAddress(`${ 'z'.repeat(32) }:${ checksummedAddress }`), addressValue)
	})

	test('trims surrounding whitespace before removing the chain short name', () => {
		assert.equal(parseUserEnteredAddress(`  ${ checksummedAddress }\t`), addressValue)
		assert.equal(parseUserEnteredAddress(`\n eth:${ checksummedAddress } \n`), addressValue)
		assert.equal(parseUserEnteredAddress(`eth: ${ checksummedAddress }`), undefined)
		assert.equal(parseUserEnteredAddress(`eth :${ checksummedAddress }`), undefined)
	})

	test('rejects syntactically invalid chain short names', () => {
		assert.equal(parseUserEnteredAddress(`:${ checksummedAddress }`), undefined)
		assert.equal(parseUserEnteredAddress(`e.th:${ checksummedAddress }`), undefined)
		assert.equal(parseUserEnteredAddress(`${ 'z'.repeat(33) }:${ checksummedAddress }`), undefined)
	})

	test('rejects more than one chain short name', () => {
		assert.equal(parseUserEnteredAddress(`eth:gno:${ checksummedAddress }`), undefined)
		assert.equal(parseUserEnteredAddress(`eth:eth:${ checksummedAddress }`), undefined)
		assert.equal(parseUserEnteredAddress(`eth::${ checksummedAddress }`), undefined)
		assert.equal(parseUserEnteredAddress(`::${ checksummedAddress }`), undefined)
		assert.equal(parseUserEnteredAddress(`eth:${ checksummedAddress }:`), undefined)
	})

	test('rejects a chain short name without an address', () => {
		assert.equal(parseUserEnteredAddress('eth:'), undefined)
		assert.equal(parseUserEnteredAddress('eth:0x'), undefined)
		assert.equal(parseUserEnteredAddress('eth:0xab5801a7d398351b8be11c439e05c5b3259aec9'), undefined)
		assert.equal(parseUserEnteredAddress(`${ checksummedAddress }:`), undefined)
	})

	test('never treats an address or other hex data as a chain short name', () => {
		for (const prefix of addressLikeChainPrefixes) {
			assert.equal(parseUserEnteredAddress(`${ prefix }:${ otherAddress }`), undefined, prefix)
			assert.equal(parseUserEnteredAddress(` ${ prefix }:${ checksummedAddress } `), undefined, prefix)
		}
	})

	test('keeps the address checksum rules for prefixed addresses', () => {
		assert.equal(parseUserEnteredAddress(`eth:${ checksummedAddress.toUpperCase().replace('0X', '0x') }`), addressValue)
		assert.equal(parseUserEnteredAddress(badChecksumAddress), undefined)
		assert.equal(parseUserEnteredAddress(`eth:${ badChecksumAddress }`), undefined)
	})
})

describe('getIssueWithUserEnteredAddress', () => {
	test('accepts plain and chain-specific addresses', () => {
		assert.equal(getIssueWithUserEnteredAddress(checksummedAddress), undefined)
		assert.equal(getIssueWithUserEnteredAddress(` eth:${ checksummedAddress } `), undefined)
		assert.equal(getIssueWithUserEnteredAddress(`lightlink_phoenix:${ checksummedAddress }`), undefined)
	})

	test('explains unsupported chain prefix forms instead of reporting the address length', () => {
		assert.equal(getIssueWithUserEnteredAddress(`eth: ${ checksummedAddress }`), chainPrefixIssue)
		assert.equal(getIssueWithUserEnteredAddress(`eth :${ checksummedAddress }`), chainPrefixIssue)
		assert.equal(getIssueWithUserEnteredAddress(`:${ checksummedAddress }`), chainPrefixIssue)
		assert.equal(getIssueWithUserEnteredAddress(`e.th:${ checksummedAddress }`), chainPrefixIssue)
		assert.equal(getIssueWithUserEnteredAddress(`${ 'z'.repeat(33) }:${ checksummedAddress }`), chainPrefixIssue)
		assert.equal(getIssueWithUserEnteredAddress(`eth:gno:${ checksummedAddress }`), chainPrefixIssue)
		assert.equal(getIssueWithUserEnteredAddress(`eth::${ checksummedAddress }`), chainPrefixIssue)
		assert.equal(getIssueWithUserEnteredAddress(`${ checksummedAddress }:`), chainPrefixIssue)
	})

	test('reports an address-like chain prefix instead of validating the address after it', () => {
		for (const prefix of addressLikeChainPrefixes) {
			assert.equal(getIssueWithUserEnteredAddress(`${ prefix }:${ otherAddress }`), chainPrefixIssue, prefix)
		}
	})

	test('keeps the address issues for the address after a valid chain prefix', () => {
		assert.equal(getIssueWithUserEnteredAddress(`eth:${ badChecksumAddress }`), `Bad address checksum, did you mean ${ checksummedAddress } ?`)
		assert.equal(getIssueWithUserEnteredAddress(badChecksumAddress), `Bad address checksum, did you mean ${ checksummedAddress } ?`)
		assert.equal(getIssueWithUserEnteredAddress('eth:0xab58'), 'Address is too short.')
	})
})

describe('removeEip3770ChainShortNameFromSearchQuery', () => {
	test('searches a pasted chain-specific address by its address part', () => {
		assert.equal(removeEip3770ChainShortNameFromSearchQuery(`eth:${ checksummedAddress }`), checksummedAddress)
		assert.equal(removeEip3770ChainShortNameFromSearchQuery(` gno:${ checksummedAddress } `), checksummedAddress)
	})

	test('keeps free-text search queries unchanged', () => {
		assert.equal(removeEip3770ChainShortNameFromSearchQuery('alice'), 'alice')
		assert.equal(removeEip3770ChainShortNameFromSearchQuery('eth:alice'), 'eth:alice')
		assert.equal(removeEip3770ChainShortNameFromSearchQuery('eth:0xab58'), 'eth:0xab58')
	})

	test('keeps a query with an address-like chain prefix unchanged', () => {
		for (const prefix of addressLikeChainPrefixes) {
			assert.equal(removeEip3770ChainShortNameFromSearchQuery(`${ prefix }:${ otherAddress }`), `${ prefix }:${ otherAddress }`, prefix)
		}
	})
})
