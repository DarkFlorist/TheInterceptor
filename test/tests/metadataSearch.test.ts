import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { getMetadataForAddressBookData } from '../../app/ts/background/metadataSearch.js'
import { addressString } from '../../app/ts/utils/bigint.js'

const installEmptyBrowserStorageMock = () => {
	const storageState: Record<string, unknown> = {}
	Object.defineProperty(globalThis, 'browser', {
		configurable: true,
		writable: true,
		value: {
			storage: {
				local: {
					async get(keys?: string | readonly string[]) {
						if (keys === undefined) return { ...storageState }
						if (typeof keys === 'string') return { [keys]: storageState[keys] }
						return Object.fromEntries(keys.map((key) => [key, storageState[key]]))
					},
					async set(items: Record<string, unknown>) {
						Object.assign(storageState, items)
					},
				},
			},
		},
	})
}

const compoundPaxDollar = 0x041171993284df560249b57358f931d9eb7b925dn
const aaveDai = 0x028171bca77440897b824ca71d1c56cac55b68a3n

describe('metadata search', () => {
	test('lists each bundled ERC20 token address once even when the bundle repeats it under another casing', async () => {
		installEmptyBrowserStorageMock()
		const { entries, maxDataLength } = await getMetadataForAddressBookData({ filter: 'ERC20 Tokens', chainId: 1n })
		const addresses = entries.map((entry) => addressString(entry.address))
		assert.equal(maxDataLength, entries.length)
		assert.equal(new Set(addresses).size, addresses.length)
		assert.deepEqual(entries.filter((entry) => entry.address === aaveDai).map((entry) => entry.name), ['Aave DAI'])
		assert.deepEqual(entries.filter((entry) => entry.address === compoundPaxDollar).map((entry) => entry.name), ['Compound Pax Dollar'])
	})

	test('returns a duplicated bundled ERC20 token once when searching for it', async () => {
		installEmptyBrowserStorageMock()
		const { entries } = await getMetadataForAddressBookData({ filter: 'ERC20 Tokens', chainId: 1n, searchString: addressString(aaveDai) })
		assert.deepEqual(entries.map((entry) => entry.address), [aaveDai])
	})
})
