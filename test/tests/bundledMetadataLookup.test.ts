import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { contractMetadata, erc1155Metadata, erc721Metadata, tokenMetadata } from '@darkflorist/address-metadata'
import { getBundledContractMetadata, getBundledErc1155Metadata, getBundledErc721Metadata, getBundledTokenMetadata } from '../../app/ts/background/bundledMetadataLookup.js'

const COMPOUND_PAX_DOLLAR_CHECKSUMMED_KEY = '0x041171993284df560249B57358F931D9eB7b925D'
const AAVE_DAI_CHECKSUMMED_KEY = '0x028171bCA77440897B824Ca71D1c56caC55b68A3'

// Every key must be found by its address, and whenever the map also has the lower case key, that entry must be the one returned, as it was before checksummed keys were found.
const assertEveryKeyResolves = <Definition>(metadata: ReadonlyMap<string, Definition>, lookup: (address: bigint) => Definition | undefined) => {
	for (const [key, definition] of metadata) {
		assert.strictEqual(lookup(BigInt(key)), metadata.get(key.toLowerCase()) ?? definition, key)
	}
}

describe('bundled metadata lookup', () => {
	test('finds a token that the bundled metadata stores only under its checksummed address', () => {
		assert.equal(tokenMetadata.has(COMPOUND_PAX_DOLLAR_CHECKSUMMED_KEY.toLowerCase()), false)
		const token = getBundledTokenMetadata(BigInt(COMPOUND_PAX_DOLLAR_CHECKSUMMED_KEY))
		assert.strictEqual(token, tokenMetadata.get(COMPOUND_PAX_DOLLAR_CHECKSUMMED_KEY))
		assert.equal(token?.name, 'Compound Pax Dollar')
	})

	test('keeps the lower case entry for a token stored under both casings', () => {
		const lowerCaseKey = AAVE_DAI_CHECKSUMMED_KEY.toLowerCase()
		assert.notStrictEqual(tokenMetadata.get(AAVE_DAI_CHECKSUMMED_KEY), tokenMetadata.get(lowerCaseKey))
		const token = getBundledTokenMetadata(BigInt(AAVE_DAI_CHECKSUMMED_KEY))
		assert.strictEqual(token, tokenMetadata.get(lowerCaseKey))
		assert.equal(token?.name, 'Aave DAI')
	})

	test('resolves every bundled address, preferring the lower case key', () => {
		assertEveryKeyResolves(contractMetadata, getBundledContractMetadata)
		assertEveryKeyResolves(tokenMetadata, getBundledTokenMetadata)
		assertEveryKeyResolves(erc721Metadata, getBundledErc721Metadata)
		assertEveryKeyResolves(erc1155Metadata, getBundledErc1155Metadata)
	})

	test('returns undefined for an address that is not bundled', () => {
		assert.equal(getBundledTokenMetadata(0x1000000000000000000000000000000000000001n), undefined)
	})
})
