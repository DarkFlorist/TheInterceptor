import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { contractMetadata, erc1155Metadata, erc721Metadata, tokenMetadata } from '@darkflorist/address-metadata'
import { findBundledMetadata, listBundledMetadata } from '../../app/ts/background/bundledMetadata.js'
import { identifyAddress } from '../../app/ts/background/metadataUtils.js'
import { checksummedAddress } from '../../app/ts/utils/bigint.js'
import { createGoerliEthereumClientServiceWithoutContracts, createOfflineMainnetEthereumClientService } from './protectorTestHarness.js'

const COMPOUND_PAX_DOLLAR_ADDRESS = 0x041171993284df560249b57358f931d9eb7b925dn

// Address lookups and code that enumerates the bundled metadata (such as the lookalike check) must know the same addresses under the same names.
describe('bundled metadata', () => {
	test('lists each address that findBundledMetadata finds exactly once, with the metadata it finds', () => {
		const bundledKeys = [contractMetadata, tokenMetadata, erc721Metadata, erc1155Metadata].flatMap((metadata) => Array.from(metadata.keys()))
		const foundAddresses = new Set(bundledKeys.map((key) => BigInt(key)).filter((address) => findBundledMetadata(address) !== undefined))
		const listed = listBundledMetadata()

		assert.equal(new Set(listed.map(({ address }) => address)).size, listed.length)
		assert.equal(listed.length, foundAddresses.size)
		for (const bundledMetadata of listed) assert.deepEqual(findBundledMetadata(bundledMetadata.address), bundledMetadata)
	})

	test('does not find or list tokens stored only under checksummed keys', () => {
		assert.equal(tokenMetadata.has(checksummedAddress(COMPOUND_PAX_DOLLAR_ADDRESS)), true)
		assert.equal(findBundledMetadata(COMPOUND_PAX_DOLLAR_ADDRESS), undefined)
		assert.equal(listBundledMetadata().some(({ address }) => address === COMPOUND_PAX_DOLLAR_ADDRESS), false)
	})

	test('identifyAddress describes every listed address with its bundled type and name', async () => {
		const ethereum = createOfflineMainnetEthereumClientService()
		for (const { address, type, definition } of listBundledMetadata()) {
			const entry = await identifyAddress(ethereum, undefined, address, false)
			assert.deepEqual({ type: entry.type, name: entry.name, entrySource: entry.entrySource }, { type, name: definition.name, entrySource: 'DarkFloristMetadata' })
		}
	})

	test('identifyAddress applies no bundled metadata type outside Ethereum mainnet', async () => {
		const ethereum = createGoerliEthereumClientServiceWithoutContracts()
		const addressByBundledType = new Map(listBundledMetadata().map(({ type, address }) => [type, address]))

		assert.deepEqual(Array.from(addressByBundledType.keys()).sort(), ['ERC1155', 'ERC20', 'ERC721', 'contract'])
		for (const [bundledType, address] of addressByBundledType) {
			const entry = await identifyAddress(ethereum, undefined, address, false)
			assert.deepEqual({ bundledType, type: entry.type, name: entry.name, entrySource: entry.entrySource }, { bundledType, type: 'contact', name: checksummedAddress(address), entrySource: 'OnChain' })
		}
	})
})
