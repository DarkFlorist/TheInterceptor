import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { tokenMetadata } from '@darkflorist/address-metadata'
import { addressString } from '../../app/ts/utils/bigint.js'

const storageState: Record<string, unknown> = { userAddressBookEntriesV3: [] }

Object.defineProperty(globalThis, 'browser', {
	configurable: true,
	writable: true,
	value: {
		storage: {
			local: {
				async get(keys?: string | readonly string[]) {
					if (keys === undefined) return { ...storageState }
					const requestedKeys = Array.isArray(keys) ? keys : [keys]
					return Object.fromEntries(requestedKeys.filter((key) => key in storageState).map((key) => [key, storageState[key]]))
				},
				async set(items: Record<string, unknown>) {
					Object.assign(storageState, items)
				},
			},
		},
	},
})

const { findEntryWithSymbolOrName, getMetadataForAddressBookData } = await import('../../app/ts/background/metadataSearch.js')

const AAVE_DAI_ADDRESS = 0x028171bca77440897b824ca71d1c56cac55b68a3n
const AAVE_WETH_ADDRESS = 0x030ba81f1c18d280636f32af80b9aad02cf0854en

const tokenAddressesKeyedInBothCasings = Array.from(tokenMetadata.keys()).filter((key) => key !== key.toLowerCase() && tokenMetadata.has(key.toLowerCase())).map((key) => key.toLowerCase())
const tokenAddressesKeyedOnlyChecksummed = Array.from(tokenMetadata.keys()).filter((key) => key !== key.toLowerCase() && !tokenMetadata.has(key.toLowerCase())).map((key) => key.toLowerCase())

const countListedAddresses = (entries: readonly { address: bigint }[]) => {
	const counts = new Map<string, number>()
	for (const address of entries.map((entry) => addressString(entry.address))) counts.set(address, (counts.get(address) ?? 0) + 1)
	return counts
}

describe('bundled ERC20 token listing', () => {
	test('bundled metadata still keys some tokens in both casings and some only checksummed', () => {
		assert.ok(tokenAddressesKeyedInBothCasings.includes(addressString(AAVE_DAI_ADDRESS)))
		assert.ok(tokenAddressesKeyedOnlyChecksummed.length > 0)
	})

	test('lists every bundled token address exactly once on mainnet', async () => {
		const { entries, maxDataLength } = await getMetadataForAddressBookData({ filter: 'ERC20 Tokens', chainId: 1n })
		const listedCounts = countListedAddresses(entries)
		for (const address of [...tokenAddressesKeyedInBothCasings, ...tokenAddressesKeyedOnlyChecksummed]) {
			assert.equal(listedCounts.get(address), 1, `${ address } should be listed once`)
		}
		assert.equal(maxDataLength, new Set(Array.from(tokenMetadata.keys()).map((key) => key.toLowerCase())).size)
		assert.equal(listedCounts.size, entries.length)
	})

	test('shows the lowercase-keyed entry that address lookups use for a token keyed in both casings', async () => {
		const { entries } = await getMetadataForAddressBookData({ filter: 'ERC20 Tokens', chainId: 1n })
		const aaveDai = entries.find((entry) => entry.address === AAVE_DAI_ADDRESS)
		assert.ok(aaveDai?.type === 'ERC20')
		assert.equal(aaveDai.name, 'Aave DAI')
		assert.equal(aaveDai.symbol, 'ADAI')
		assert.ok(aaveDai.logoUri?.endsWith('/images/tokens/0x028171bca77440897b824ca71d1c56cac55b68a3.png'))
	})

	test('address search returns a token keyed in both casings once', async () => {
		const { entries } = await getMetadataForAddressBookData({ filter: 'ERC20 Tokens', chainId: 1n, searchString: addressString(AAVE_DAI_ADDRESS) })
		assert.deepEqual(entries.map((entry) => entry.name), ['Aave DAI'])
	})
})

describe('bundled entry lookup by symbol or name', () => {
	test('resolves a symbol shared by both casings of a token to the lowercase-keyed entry', async () => {
		const entry = await findEntryWithSymbolOrName('aweth', undefined, 1n)
		assert.ok(entry?.type === 'ERC20')
		assert.equal(entry.address, AAVE_WETH_ADDRESS)
		assert.equal(entry.name, 'Aave WETH')
		assert.equal(entry.symbol, 'AWETH')
	})
})
