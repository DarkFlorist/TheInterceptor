import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { contractMetadata, erc1155Metadata, erc721Metadata, tokenMetadata } from '@darkflorist/address-metadata'
import { bundledContractMetadata, bundledErc1155Metadata, bundledErc721Metadata, bundledTokenMetadata } from '../../app/ts/background/bundledAddressMetadata.js'

type BundledMetadataPair = {
	name: string
	raw: ReadonlyMap<string, unknown>
	normalized: ReadonlyMap<string, unknown>
}

const bundledMetadataPairs: readonly BundledMetadataPair[] = [
	{ name: 'tokenMetadata', raw: tokenMetadata, normalized: bundledTokenMetadata },
	{ name: 'contractMetadata', raw: contractMetadata, normalized: bundledContractMetadata },
	{ name: 'erc721Metadata', raw: erc721Metadata, normalized: bundledErc721Metadata },
	{ name: 'erc1155Metadata', raw: erc1155Metadata, normalized: bundledErc1155Metadata },
]

const normalizedModulePath = 'app/ts/background/bundledAddressMetadata.ts'

describe('bundled address metadata', () => {
	test('indexes every raw bundled key under its lowercase address', () => {
		for (const { name, raw, normalized } of bundledMetadataPairs) {
			const rawLowercaseAddresses = new Set(Array.from(raw.keys(), (address) => address.toLowerCase()))
			for (const address of raw.keys()) assert.ok(normalized.has(address.toLowerCase()), `${ name } is missing ${ address }`)
			for (const address of normalized.keys()) assert.equal(address, address.toLowerCase(), `${ name } has a non-lowercase key ${ address }`)
			assert.equal(normalized.size, rawLowercaseAddresses.size, `${ name } has unexpected extra keys`)
		}
	})

	test('prefers the lowercase raw entry when an address is listed under several casings', () => {
		for (const { name, raw, normalized } of bundledMetadataPairs) {
			for (const [address, definition] of raw) {
				if (address !== address.toLowerCase()) continue
				assert.equal(normalized.get(address), definition, `${ name } did not keep the lowercase entry for ${ address }`)
			}
		}
	})

	test('only the normalizing module reads the raw bundled metadata maps', async () => {
		const rawMetadataValueImport = /^import (?!type\b).*from '@darkflorist\/address-metadata'/mu
		const filesImportingRawMetadata: string[] = []
		for await (const file of new Bun.Glob('app/ts/**/*.{ts,tsx}').scan('.')) {
			if (rawMetadataValueImport.test(await Bun.file(file).text())) filesImportingRawMetadata.push(file)
		}
		assert.deepEqual(filesImportingRawMetadata, [normalizedModulePath])
	})
})
