import * as assert from 'assert'
import { beforeAll, describe, test } from 'bun:test'
import { contractMetadata, erc1155Metadata, erc721Metadata, tokenMetadata } from '@darkflorist/address-metadata'
import { findEntryWithSymbolOrName, getMetadataForAddressBookData } from '../../app/ts/background/metadataSearch.js'
import { updateUserAddressBookEntries } from '../../app/ts/background/storageVariables.js'
import type { AddressBookEntries, ChainIdWithUniversal } from '../../app/ts/types/addressBookTypes.js'
import type { AddressBookCategory } from '../../app/ts/types/interceptor-messages.js'
import { installBrowserStorageMock } from './protectorTestHarness.js'

installBrowserStorageMock()

const WETH_ADDRESS = 0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2n
const GOERLI_CHAIN_ID = 5n
const LOGO_URI_PREFIX = '../vendor/@darkflorist/address-metadata'

const userEntries: AddressBookEntries = [
	{ type: 'ERC20', name: 'My Wrapped Ether', symbol: 'MYWETH', decimals: 18n, address: WETH_ADDRESS, entrySource: 'User', chainId: 1n },
	{ type: 'ERC20', name: 'Goerli Test Token', symbol: 'GTT', decimals: 18n, address: 0x1001n, entrySource: 'User', chainId: GOERLI_CHAIN_ID },
	{ type: 'ERC20', name: 'Universal Token', symbol: 'UNI2', decimals: 18n, address: 0x1002n, entrySource: 'User', chainId: 'AllChains' },
	{ type: 'ERC721', name: 'Goerli Kitties', symbol: 'GKITTY', address: 0x1003n, entrySource: 'User', chainId: GOERLI_CHAIN_ID },
	{ type: 'ERC1155', name: 'Goerli Items', symbol: 'GITEM', decimals: undefined, address: 0x1004n, entrySource: 'User', chainId: GOERLI_CHAIN_ID },
	{ type: 'contract', name: 'Goerli Router', address: 0x1005n, entrySource: 'User', chainId: GOERLI_CHAIN_ID },
	{ type: 'contract', name: 'Mainnet Vault', address: 0x1006n, entrySource: 'User', chainId: 1n },
]

beforeAll(async () => {
	await updateUserAddressBookEntries(() => userEntries)
})

const withLogoUri = (logoUri: string | undefined) => logoUri === undefined ? {} : { logoUri: `${ LOGO_URI_PREFIX }${ logoUri }` }

// Every key of each bundled map in package order, checksummed duplicates included, is how the address book has always listed the bundled metadata of a category on mainnet.
const bundledEntriesByCategory = {
	'ERC20 Tokens': Array.from(tokenMetadata, ([key, { logoUri, ...rest }]) => ({ ...rest, ...withLogoUri(logoUri), address: BigInt(key), type: 'ERC20', entrySource: 'DarkFloristMetadata' })),
	'Non Fungible Tokens': Array.from(erc721Metadata, ([key, { logoUri, ...rest }]) => ({ ...rest, ...withLogoUri(logoUri), address: BigInt(key), type: 'ERC721', entrySource: 'DarkFloristMetadata' })),
	'ERC1155 Tokens': Array.from(erc1155Metadata, ([key, { logoUri, ...rest }]) => ({ ...rest, ...withLogoUri(logoUri), address: BigInt(key), type: 'ERC1155', entrySource: 'DarkFloristMetadata', decimals: undefined })),
	'Other Contracts': Array.from(contractMetadata, ([key, { logoUri, ...rest }]) => ({ ...rest, ...withLogoUri(logoUri), address: BigInt(key), type: 'contract', entrySource: 'DarkFloristMetadata' })),
} as const

const BUNDLED_CATEGORIES = ['ERC20 Tokens', 'Non Fungible Tokens', 'ERC1155 Tokens', 'Other Contracts'] as const
const userEntryTypeByCategory = { 'ERC20 Tokens': 'ERC20', 'Non Fungible Tokens': 'ERC721', 'ERC1155 Tokens': 'ERC1155', 'Other Contracts': 'contract' } as const

const userEntriesOfCategoryForChain = (category: keyof typeof userEntryTypeByCategory, chainId: ChainIdWithUniversal) => userEntries.filter((entry) => entry.type === userEntryTypeByCategory[category] && (entry.chainId === chainId || entry.chainId === 'AllChains'))

const searchAddressBook = async (filter: AddressBookCategory, chainId: ChainIdWithUniversal, searchString?: string) => await getMetadataForAddressBookData({ filter, chainId, searchString, startIndex: 0, maxIndex: 100000 })

const namesOf = (entries: AddressBookEntries) => entries.map((entry) => entry.name)

describe('metadataSearch', () => {
	test('lists user entries first and then every bundled entry of the category not already listed on mainnet', async () => {
		for (const category of BUNDLED_CATEGORIES) {
			const userEntriesOfCategory = userEntriesOfCategoryForChain(category, 1n)
			const userAddresses = new Set(userEntriesOfCategory.map(({ address }) => address))
			const expected = [...userEntriesOfCategory, ...bundledEntriesByCategory[category].filter(({ address }) => !userAddresses.has(address))]
			const { entries, maxDataLength } = await searchAddressBook(category, 1n)
			assert.deepEqual({ category, entries }, { category, entries: expected })
			assert.equal(maxDataLength, expected.length)
		}
	})

	test('lists only user entries on another chain and for AllChains', async () => {
		for (const chainId of [GOERLI_CHAIN_ID, 'AllChains'] as const) {
			for (const category of BUNDLED_CATEGORIES) {
				const { entries } = await searchAddressBook(category, chainId)
				assert.deepEqual({ chainId, category, entries }, { chainId, category, entries: userEntriesOfCategoryForChain(category, chainId) })
			}
		}
	})

	test('orders search results the same way on mainnet', async () => {
		assert.deepEqual(namesOf((await searchAddressBook('ERC20 Tokens', 1n, 'weth')).entries).slice(0, 5), ['Aave interest bearing WETH', 'Aave WETH', 'Aave v3 WETH', 'Swell Ethereum', 'My Wrapped Ether'])
		assert.deepEqual(namesOf((await searchAddressBook('Other Contracts', 1n, 'uniswap v2')).entries).slice(0, 5), ['Uniswap V2 Pair: WETH - ISP', 'Uniswap V2 Pair: WBTC - USDC', 'Uniswap V2 Pair: SHIBARIUM - WETH', 'Uniswap V2 Pair: HACHI - WETH', 'Uniswap V2 Pair: DOP - WETH'])
		assert.deepEqual(namesOf((await searchAddressBook('Non Fungible Tokens', 1n, 'ens')).entries).slice(0, 5), ['ENS: Ethereum Name Service', 'ENS Maxis', '8liens NFT', 'Beanbag Frens', 'Censored Boys Syndicate'])
		assert.deepEqual(namesOf((await searchAddressBook('ERC1155 Tokens', 1n, 'art')).entries).slice(0, 5), ['HBBs by MarkTheHabibi', 'TPL Mecha Part', 'OS Shared Storefront Collection', 'MetaHero: MintPass', 'MetaHero: United Planets'])
		assert.deepEqual(namesOf((await searchAddressBook('ERC20 Tokens', 1n, 'usd')).entries).slice(0, 8), ['USDA', 'USDEBT', 'USDD', 'Verified USD', 'Bridged Tether  Wormhole ', 'Ethereum Reserve Dollar USDE', 'USDV', 'SpiceUSD'])
		assert.equal((await searchAddressBook('ERC20 Tokens', 1n, 'usdc')).maxDataLength, 44)
		assert.deepEqual(namesOf((await searchAddressBook('ERC20 Tokens', 1n, 'eth:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2')).entries), ['My Wrapped Ether'])
	})

	test('searches only user entries on another chain and for AllChains', async () => {
		assert.deepEqual(namesOf((await searchAddressBook('ERC20 Tokens', GOERLI_CHAIN_ID, 't')).entries), ['Goerli Test Token', 'Universal Token'])
		assert.deepEqual(namesOf((await searchAddressBook('Other Contracts', GOERLI_CHAIN_ID, 'router')).entries), ['Goerli Router'])
		assert.deepEqual(namesOf((await searchAddressBook('ERC20 Tokens', 'AllChains', 'token')).entries), ['Universal Token'])
		assert.deepEqual(namesOf((await searchAddressBook('Other Contracts', 'AllChains', 'uniswap')).entries), [])
	})

	test('finds bundled entries by symbol or name on mainnet and for AllChains but not on another chain', async () => {
		const bundledWeth = bundledEntriesByCategory['ERC20 Tokens'].find(({ address }) => address === WETH_ADDRESS)
		for (const chainId of [1n, 'AllChains'] as const) {
			assert.deepEqual(await findEntryWithSymbolOrName('weth', undefined, chainId), bundledWeth)
			assert.deepEqual(await findEntryWithSymbolOrName(undefined, 'weth', chainId), bundledWeth)
			assert.deepEqual((await findEntryWithSymbolOrName(undefined, 'Uniswap V2 Router 02', chainId))?.type, 'contract')
		}
		assert.equal(await findEntryWithSymbolOrName('weth', 'weth', GOERLI_CHAIN_ID), undefined)
		assert.equal((await findEntryWithSymbolOrName(undefined, 'Uniswap V2 Router 02', GOERLI_CHAIN_ID)), undefined)
		assert.deepEqual(await findEntryWithSymbolOrName('gtt', undefined, GOERLI_CHAIN_ID), userEntries[1])
		assert.deepEqual(await findEntryWithSymbolOrName('myweth', undefined, 1n), userEntries[0])
		assert.deepEqual(await findEntryWithSymbolOrName(undefined, 'universal token', 'AllChains'), userEntries[2])
	})
})
