import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { getIssueWithAddressString, getIssueWithUserEnteredAddress, parseUserEnteredAddress, removeEip3770ChainShortNameFromSearchQuery } from '../../app/ts/utils/addressValidation.js'

const checksummedAddress = '0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B'
const checksummedAddressHexDigits = checksummedAddress.slice(2)
const badChecksumAddress = '0xaB5801a7D398351b8bE11C439e05C5B3259aeC9B'
const addressValue = 0xab5801a7d398351b8be11c439e05c5b3259aec9bn
const otherAddress = '0x0000000000000000000000000000000000000123'
const chainPrefixIssue = 'Chain prefix must be an EIP-3770 short name followed directly by the address (e.g. eth:0x...).'
const ethereumChainId = 1n
const gnosisChainId = 100n
const gnosisAddressOnEthereumIssue = 'This address is for Gnosis (gno:), but this entry is for Ethereum Mainnet.'

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
		assert.equal(parseUserEnteredAddress(checksummedAddress, ethereumChainId), addressValue)
		assert.equal(parseUserEnteredAddress(checksummedAddress.toLowerCase(), gnosisChainId), addressValue)
		assert.equal(parseUserEnteredAddress(checksummedAddress, 'AllChains'), addressValue)
		assert.equal(parseUserEnteredAddress(undefined, ethereumChainId), undefined)
	})

	test('parses EIP-3770 chain-specific addresses for the chain their short name names', () => {
		assert.equal(parseUserEnteredAddress(`eth:${ checksummedAddress }`, ethereumChainId), addressValue)
		assert.equal(parseUserEnteredAddress(`gno:${ checksummedAddress.toLowerCase() }`, gnosisChainId), addressValue)
		assert.equal(parseUserEnteredAddress(`arb1:${ checksummedAddress }`, 42161n), addressValue)
		assert.equal(parseUserEnteredAddress(`matic:${ checksummedAddress }`, 137n), addressValue)
		assert.equal(parseUserEnteredAddress(`pol:${ checksummedAddress }`, 137n), addressValue)
		assert.equal(parseUserEnteredAddress(`sep:${ checksummedAddress }`, 11155111n), addressValue)
	})

	test('rejects a known short name that names another chain than the entry', () => {
		assert.equal(parseUserEnteredAddress(`gno:${ checksummedAddress }`, ethereumChainId), undefined)
		assert.equal(parseUserEnteredAddress(`eth:${ checksummedAddress }`, gnosisChainId), undefined)
		assert.equal(parseUserEnteredAddress(`sep:${ checksummedAddress }`, ethereumChainId), undefined)
		assert.equal(parseUserEnteredAddress(` oeth:${ checksummedAddress } `, 42161n), undefined)
	})

	test('compares short names exactly, so a differently cased known name is not compared', () => {
		assert.equal(parseUserEnteredAddress(`GNO:${ checksummedAddress }`, ethereumChainId), addressValue)
		assert.equal(parseUserEnteredAddress(`Eth:${ checksummedAddress }`, gnosisChainId), addressValue)
	})

	test('accepts short names whose chain is unknown, because they cannot be compared', () => {
		assert.equal(parseUserEnteredAddress(`base-sep:${ checksummedAddress }`, ethereumChainId), addressValue)
		assert.equal(parseUserEnteredAddress(`lightlink_phoenix:${ checksummedAddress }`, gnosisChainId), addressValue)
	})

	test('accepts any short name for an entry on all chains', () => {
		assert.equal(parseUserEnteredAddress(`gno:${ checksummedAddress }`, 'AllChains'), addressValue)
		assert.equal(parseUserEnteredAddress(`eth:${ checksummedAddress }`, 'AllChains'), addressValue)
	})

	// The all-chains entry skips the chain comparison, so these cases check only the short-name syntax.
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
			assert.equal(parseUserEnteredAddress(`${ shortName }:${ checksummedAddress }`, 'AllChains'), addressValue, shortName)
		}
		assert.equal(parseUserEnteredAddress(`${ 'z'.repeat(32) }:${ checksummedAddress }`, 'AllChains'), addressValue)
	})

	test('trims surrounding whitespace before removing the chain short name', () => {
		assert.equal(parseUserEnteredAddress(`  ${ checksummedAddress }\t`, ethereumChainId), addressValue)
		assert.equal(parseUserEnteredAddress(`\n eth:${ checksummedAddress } \n`, ethereumChainId), addressValue)
		assert.equal(parseUserEnteredAddress(`eth: ${ checksummedAddress }`, ethereumChainId), undefined)
		assert.equal(parseUserEnteredAddress(`eth :${ checksummedAddress }`, ethereumChainId), undefined)
	})

	test('rejects syntactically invalid chain short names', () => {
		assert.equal(parseUserEnteredAddress(`:${ checksummedAddress }`, ethereumChainId), undefined)
		assert.equal(parseUserEnteredAddress(`e.th:${ checksummedAddress }`, ethereumChainId), undefined)
		assert.equal(parseUserEnteredAddress(`${ 'z'.repeat(33) }:${ checksummedAddress }`, ethereumChainId), undefined)
	})

	test('rejects more than one chain short name', () => {
		assert.equal(parseUserEnteredAddress(`eth:gno:${ checksummedAddress }`, ethereumChainId), undefined)
		assert.equal(parseUserEnteredAddress(`eth:eth:${ checksummedAddress }`, ethereumChainId), undefined)
		assert.equal(parseUserEnteredAddress(`eth::${ checksummedAddress }`, ethereumChainId), undefined)
		assert.equal(parseUserEnteredAddress(`::${ checksummedAddress }`, ethereumChainId), undefined)
		assert.equal(parseUserEnteredAddress(`eth:${ checksummedAddress }:`, ethereumChainId), undefined)
	})

	test('rejects a chain short name without an address', () => {
		assert.equal(parseUserEnteredAddress('eth:', ethereumChainId), undefined)
		assert.equal(parseUserEnteredAddress('eth:0x', ethereumChainId), undefined)
		assert.equal(parseUserEnteredAddress('eth:0xab5801a7d398351b8be11c439e05c5b3259aec9', ethereumChainId), undefined)
		assert.equal(parseUserEnteredAddress(`${ checksummedAddress }:`, ethereumChainId), undefined)
	})

	test('never treats an address or other hex data as a chain short name', () => {
		for (const prefix of addressLikeChainPrefixes) {
			assert.equal(parseUserEnteredAddress(`${ prefix }:${ otherAddress }`, ethereumChainId), undefined, prefix)
			assert.equal(parseUserEnteredAddress(` ${ prefix }:${ checksummedAddress } `, ethereumChainId), undefined, prefix)
		}
	})

	test('keeps the address checksum rules for prefixed addresses', () => {
		assert.equal(parseUserEnteredAddress(`eth:${ checksummedAddress.toUpperCase().replace('0X', '0x') }`, ethereumChainId), addressValue)
		assert.equal(parseUserEnteredAddress(badChecksumAddress, ethereumChainId), undefined)
		assert.equal(parseUserEnteredAddress(`eth:${ badChecksumAddress }`, ethereumChainId), undefined)
	})
})

describe('getIssueWithUserEnteredAddress', () => {
	test('accepts plain and chain-specific addresses', () => {
		assert.equal(getIssueWithUserEnteredAddress(checksummedAddress, ethereumChainId), undefined)
		assert.equal(getIssueWithUserEnteredAddress(` eth:${ checksummedAddress } `, ethereumChainId), undefined)
		assert.equal(getIssueWithUserEnteredAddress(`gno:${ checksummedAddress }`, gnosisChainId), undefined)
		assert.equal(getIssueWithUserEnteredAddress(`gno:${ checksummedAddress }`, 'AllChains'), undefined)
		assert.equal(getIssueWithUserEnteredAddress(`lightlink_phoenix:${ checksummedAddress }`, ethereumChainId), undefined)
	})

	test('names both chains when a known short name names another chain than the entry', () => {
		assert.equal(getIssueWithUserEnteredAddress(`gno:${ checksummedAddress }`, ethereumChainId), gnosisAddressOnEthereumIssue)
		assert.equal(getIssueWithUserEnteredAddress(` gno:${ checksummedAddress.toLowerCase() } `, ethereumChainId), gnosisAddressOnEthereumIssue)
		assert.equal(getIssueWithUserEnteredAddress(`eth:${ checksummedAddress }`, gnosisChainId), 'This address is for Ethereum Mainnet (eth:), but this entry is for Gnosis.')
		assert.equal(getIssueWithUserEnteredAddress(`gno:${ checksummedAddress }`, 987654321987n), 'This address is for Gnosis (gno:), but this entry is for Chain: 987654321987.')
	})

	test('explains unsupported chain prefix forms instead of reporting the address length', () => {
		assert.equal(getIssueWithUserEnteredAddress(`eth: ${ checksummedAddress }`, ethereumChainId), chainPrefixIssue)
		assert.equal(getIssueWithUserEnteredAddress(`eth :${ checksummedAddress }`, ethereumChainId), chainPrefixIssue)
		assert.equal(getIssueWithUserEnteredAddress(`:${ checksummedAddress }`, ethereumChainId), chainPrefixIssue)
		assert.equal(getIssueWithUserEnteredAddress(`e.th:${ checksummedAddress }`, ethereumChainId), chainPrefixIssue)
		assert.equal(getIssueWithUserEnteredAddress(`${ 'z'.repeat(33) }:${ checksummedAddress }`, ethereumChainId), chainPrefixIssue)
		assert.equal(getIssueWithUserEnteredAddress(`eth:gno:${ checksummedAddress }`, ethereumChainId), chainPrefixIssue)
		assert.equal(getIssueWithUserEnteredAddress(`eth::${ checksummedAddress }`, ethereumChainId), chainPrefixIssue)
		assert.equal(getIssueWithUserEnteredAddress(`${ checksummedAddress }:`, ethereumChainId), chainPrefixIssue)
	})

	test('reports an address-like chain prefix instead of validating the address after it', () => {
		for (const prefix of addressLikeChainPrefixes) {
			assert.equal(getIssueWithUserEnteredAddress(`${ prefix }:${ otherAddress }`, ethereumChainId), chainPrefixIssue, prefix)
		}
	})

	test('keeps the address issues for the address after a valid chain prefix', () => {
		assert.equal(getIssueWithUserEnteredAddress(`eth:${ badChecksumAddress }`, ethereumChainId), `Bad address checksum, did you mean ${ checksummedAddress } ?`)
		assert.equal(getIssueWithUserEnteredAddress(badChecksumAddress, ethereumChainId), `Bad address checksum, did you mean ${ checksummedAddress } ?`)
		assert.equal(getIssueWithUserEnteredAddress('eth:0xab58', ethereumChainId), 'Address is too short.')
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
