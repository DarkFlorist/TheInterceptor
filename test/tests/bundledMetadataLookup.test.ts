import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { contractMetadata, erc1155Metadata, erc721Metadata, tokenMetadata } from '@darkflorist/address-metadata'
import { getBundledContractMetadata, getBundledErc1155Metadata, getBundledErc721Metadata, getBundledTokenMetadata, listBundledContractMetadata, listBundledErc1155Metadata, listBundledErc721Metadata, listBundledTokenMetadata } from '../../app/ts/background/bundledMetadataLookup.js'

const COMPOUND_PAX_DOLLAR_CHECKSUMMED_KEY = '0x041171993284df560249B57358F931D9eB7b925D'
const AAVE_DAI_CHECKSUMMED_KEY = '0x028171bCA77440897B824Ca71D1c56caC55b68A3'

// The reviewed bundled tokens that only the checksummed lookup identifies, and so are trusted as bundled metadata rather than flagged as unknown on-chain addresses: all Compound and Aave tokens of @darkflorist/address-metadata 0.10.0. A dependency bump that changes this set must update this list.
const REVIEWED_CHECKSUMMED_ONLY_TOKEN_KEYS = [
	'0x041171993284df560249B57358F931D9eB7b925D',
	'0x12392F67bdf24faE0AF363c24aC620a2f67DAd86',
	'0x158079Ee67Fce2f58472A96584A73C7Ab9AC95c1',
	'0x1E6bb68Acec8fefBD87D192bE09bb274170a0548',
	'0x2e8F4bdbE3d47d7d7DE490437AeA9915D930F1A3',
	'0x514cd6756CCBe28772d4Cb81bC3156BA9d1744aa',
	'0x683923dB55Fead99A79Fa01A27EeC3cB19679cC3',
	'0x6F634c6135D2EBD550000ac92F494F9CB8183dAe',
	'0x7713DD9Ca933848F6819F38B8352D9A15EA73F67',
	'0x952749E07d7157bb9644A894dFAF3Bad5eF6D918',
	'0x9a14e23A58edf4EFDcB360f68cd1b95ce2081a2F',
	'0xB29130CBcC3F791f077eAdE0266168E808E5151e',
	'0xC11b1268C1A384e55C48c2391d8d480264A3A7F4',
	'0xF5DCe57282A584D2746FaF1593d3121Fcac444dC',
	'0xc2e2152647F4C26028482Efaf64b2Aa28779EFC4',
	'0xce1871f791548600cb59efbefFC9c38719142079',
	'0xd4937682df3C8aEF4FE912A96A74121C0829E664',
	'0xf650C3d88D12dB855b8bf7D11Be6C55A4e07dCC9',
]

// The keys of a bundled map that only a checksummed lookup finds, because the map has no lower case key for the address.
const getChecksummedOnlyKeys = (metadata: ReadonlyMap<string, unknown>) => Array.from(metadata.keys()).filter((key) => key !== key.toLowerCase() && !metadata.has(key.toLowerCase()))

// Every key must be found by its address, and whenever the map also has the lower case key, that entry must be the one returned, as it was before checksummed keys were found.
const assertEveryKeyResolves = <Definition>(metadata: ReadonlyMap<string, Definition>, lookup: (address: bigint) => Definition | undefined) => {
	for (const [key, definition] of metadata) {
		assert.strictEqual(lookup(BigInt(key)), metadata.get(key.toLowerCase()) ?? definition, key)
	}
}

// The listing must hold every bundled address exactly once, under its lower case key, at the position of its first key in map order, with the entry the lookup returns for it.
const assertListsEveryAddressOnce = <Definition>(metadata: ReadonlyMap<string, Definition>, list: () => Iterable<[string, Definition]>, lookup: (address: bigint) => Definition | undefined) => {
	const listed = Array.from(list())
	const listedKeys = listed.map(([key]) => key)
	assert.deepEqual(listedKeys, Array.from(new Set(Array.from(metadata.keys(), (key) => key.toLowerCase()))))
	for (const [key, definition] of listed) assert.strictEqual(definition, lookup(BigInt(key)), key)
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

	test('lists every bundled address once with the entry its lookup returns', () => {
		assertListsEveryAddressOnce(contractMetadata, listBundledContractMetadata, getBundledContractMetadata)
		assertListsEveryAddressOnce(tokenMetadata, listBundledTokenMetadata, getBundledTokenMetadata)
		assertListsEveryAddressOnce(erc721Metadata, listBundledErc721Metadata, getBundledErc721Metadata)
		assertListsEveryAddressOnce(erc1155Metadata, listBundledErc1155Metadata, getBundledErc1155Metadata)
	})

	test('trusts only the reviewed checksummed-only bundled entries', () => {
		assert.deepEqual(getChecksummedOnlyKeys(contractMetadata), [])
		assert.deepEqual(new Set(getChecksummedOnlyKeys(tokenMetadata)), new Set(REVIEWED_CHECKSUMMED_ONLY_TOKEN_KEYS))
		assert.deepEqual(getChecksummedOnlyKeys(erc721Metadata), [])
		assert.deepEqual(getChecksummedOnlyKeys(erc1155Metadata), [])
	})

	test('returns undefined for an address that is not bundled', () => {
		assert.equal(getBundledTokenMetadata(0x1000000000000000000000000000000000000001n), undefined)
	})
})
