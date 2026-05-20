import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { searchWebsiteAccess } from '../../app/ts/background/websiteAccessSearch.js'
import type { WebsiteAccess, WebsiteAccessArray } from '../../app/ts/types/websiteAccessTypes.js'
import { addressString } from '../../app/ts/utils/bigint.js'
import { EthereumAddress } from '../../app/ts/types/wire-types.js'

const createWebsiteAccess = (title: string | undefined, origin: string, addresses: string[] = []): WebsiteAccess => ({
	website: { title, websiteOrigin: origin, icon: undefined },
	addressAccess: addresses.length ? addresses.map(addr => ({ address: EthereumAddress.parse(addr), access: true })) : undefined,
})

const testData: WebsiteAccessArray = [
	createWebsiteAccess('Ethereum Foundation', 'ethereum.org', ['0x0000000000000000000000000000000000000123']),
	createWebsiteAccess('Uniswap', 'app.uniswap.org', ['0x0000000000000000000000000000000000000789']),
	createWebsiteAccess(undefined, 'etherscan.io', ['0x0000000000000000000000000000000000000abc']),
	createWebsiteAccess('OpenSea', 'opensea.io'),
	createWebsiteAccess('Lunaria', 'lunaria.dark.florist'),
	createWebsiteAccess('MultiAddress DApp', 'multi.dapp', [
		'0x0000000000000000000000000000000000001234',
		'0x0000000000000000000000000000000000012345',
		'0x0000000000000000000000000000000000789abc',
	]),
]

describe('searchWebsiteAccess', () => {
	test('returns the original array reference for an empty query', () => {
		assert.equal(searchWebsiteAccess('', testData), testData)
	})

	test('returns all entries for a whitespace-only query', () => {
		assert.equal(searchWebsiteAccess('   ', testData).length, testData.length)
	})

	test('matches a partial title and ranks Lunaria first', () => {
		assert.equal(searchWebsiteAccess('lu', testData)[0], testData[4])
	})

	test('finds websites by title', () => {
		assert.equal(searchWebsiteAccess('ethereum', testData)[0], testData[0])
	})

	test('finds websites by origin', () => {
		assert.equal(searchWebsiteAccess('uniswap', testData)[0], testData[1])
	})

	test('finds websites by ethereum address', () => {
		const result = searchWebsiteAccess('0x123', testData)
		assert.equal(result.length >= 2, true)
		assert.equal(result.some(entry => entry.website.websiteOrigin === 'ethereum.org'), true)
		assert.equal(result.some(entry => entry.website.websiteOrigin === 'multi.dapp'), true)
	})

	test('matches websites with an undefined title by origin', () => {
		assert.equal(searchWebsiteAccess('etherscan', testData)[0], testData[2])
	})

	test('ranks longer fuzzy matches ahead of shorter ones', () => {
		const entries: WebsiteAccessArray = [
			createWebsiteAccess('Swap', 'swap.org'),
			createWebsiteAccess('Spread Letters', 'sxxwxxaxxpp.org'),
		]
		const result = searchWebsiteAccess('swap', entries)
		assert.deepEqual(result.map(entry => entry.website.websiteOrigin), ['sxxwxxaxxpp.org', 'swap.org'])
	})

	test('sorts multiple matches by descending fuzzy match length', () => {
		const entries: WebsiteAccessArray = [
			createWebsiteAccess('Shortest', 'swap.org'),
			createWebsiteAccess('Middle', 'sxxwxxap.org'),
			createWebsiteAccess('Longest', 'sxxwxxaxxpp.org'),
		]
		const result = searchWebsiteAccess('swap', entries)
		assert.deepEqual(result.map(entry => entry.website.websiteOrigin), ['sxxwxxaxxpp.org', 'sxxwxxap.org', 'swap.org'])
	})

	test('matches non-sequential characters', () => {
		assert.equal(searchWebsiteAccess('usp', testData).some((entry) => entry.website.websiteOrigin === 'app.uniswap.org'), true)
	})

	test('finds partial ethereum address matches', () => {
		const result = searchWebsiteAccess('0x1234', testData)
		assert.equal(result.some((entry) => entry.website.websiteOrigin === 'multi.dapp'), true)
		assert.equal(result.some((entry) => entry.addressAccess?.some((addr) => addressString(addr.address).endsWith('1234'))), true)
	})

	test('performs a case-insensitive search', () => {
		assert.equal(searchWebsiteAccess('ETHEREUM', testData)[0], testData[0])
	})

	test('matches mixed-case patterns', () => {
		assert.equal(searchWebsiteAccess('UnIsWaP', testData).some((entry) => entry.website.websiteOrigin === 'app.uniswap.org'), true)
	})

	test('handles URLs with special characters in the query', () => {
		assert.equal(searchWebsiteAccess('.org', testData).length > 0, true)
	})

	test('treats regex special characters as plain text', () => {
		assert.equal(searchWebsiteAccess('.*+?^${}()|[]\\', testData).length, 0)
	})

	test('supports unicode characters', () => {
		const unicodeTestData: WebsiteAccessArray = [
			createWebsiteAccess('Café', 'café.org'),
			createWebsiteAccess('München', 'münich.de'),
			createWebsiteAccess('東京', '東京.jp'),
		]

		assert.equal(searchWebsiteAccess('café', unicodeTestData)[0]?.website.websiteOrigin, 'café.org')
		assert.equal(searchWebsiteAccess('münich', unicodeTestData)[0]?.website.websiteOrigin, 'münich.de')
		assert.equal(searchWebsiteAccess('東京', unicodeTestData)[0]?.website.websiteOrigin, '東京.jp')
	})
})
