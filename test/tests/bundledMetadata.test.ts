import * as assert from 'assert'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, test } from 'bun:test'
import * as ts from 'typescript'
import { contractMetadata, erc1155Metadata, erc721Metadata, tokenMetadata } from '@darkflorist/address-metadata'
import * as bundledMetadataModule from '../../app/ts/background/bundledMetadata.js'
import { findBundledMetadataForChain, listBundledMetadataForChain } from '../../app/ts/background/bundledMetadata.js'
import { getKnownAddressIndexes } from '../../app/ts/background/lookalikeKnownAddresses.js'
import { identifyAddress } from '../../app/ts/background/metadataUtils.js'
import type { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import { checksummedAddress } from '../../app/ts/utils/bigint.js'
import { createGoerliEthereumClientServiceWithoutContracts, createOfflineMainnetEthereumClientService } from './protectorTestHarness.js'

const COMPOUND_PAX_DOLLAR_ADDRESS = 0x041171993284df560249b57358f931d9eb7b925dn
const WETH_ADDRESS = 0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2n
const GOERLI_CHAIN_ID = 5n

// Address lookups and code that enumerates the bundled metadata (such as the lookalike check) must know the same addresses under the same names.
describe('bundled metadata', () => {
	test('lists each address that findBundledMetadataForChain finds exactly once, with the metadata it finds', () => {
		const bundledKeys = [contractMetadata, tokenMetadata, erc721Metadata, erc1155Metadata].flatMap((metadata) => Array.from(metadata.keys()))
		const foundAddresses = new Set(bundledKeys.map((key) => BigInt(key)).filter((address) => findBundledMetadataForChain(address, 1n) !== undefined))
		const listed = listBundledMetadataForChain(1n)

		assert.equal(new Set(listed.map(({ address }) => address)).size, listed.length)
		assert.equal(listed.length, foundAddresses.size)
		for (const bundledMetadata of listed) assert.deepEqual(findBundledMetadataForChain(bundledMetadata.address, 1n), bundledMetadata)
	})

	test('does not find or list tokens stored only under checksummed keys', () => {
		assert.equal(tokenMetadata.has(checksummedAddress(COMPOUND_PAX_DOLLAR_ADDRESS)), true)
		assert.equal(findBundledMetadataForChain(COMPOUND_PAX_DOLLAR_ADDRESS, 1n), undefined)
		assert.equal(listBundledMetadataForChain(1n).some(({ address }) => address === COMPOUND_PAX_DOLLAR_ADDRESS), false)
	})

	test('applies only on Ethereum mainnet', () => {
		assert.equal(findBundledMetadataForChain(WETH_ADDRESS, 1n)?.definition.name, 'WETH')
		assert.equal(listBundledMetadataForChain(1n).some(({ address }) => address === WETH_ADDRESS), true)
		for (const chainId of [GOERLI_CHAIN_ID, 10n]) {
			assert.equal(findBundledMetadataForChain(WETH_ADDRESS, chainId), undefined)
			assert.deepEqual(listBundledMetadataForChain(chainId), [])
		}
	})

	test('exports only chain aware accessors', () => {
		assert.deepEqual(Object.keys(bundledMetadataModule).sort(), ['findBundledMetadataForChain', 'listBundledMetadataForChain'])
	})

	test('identifyAddress describes every listed address with its bundled type and name', async () => {
		const ethereum = createOfflineMainnetEthereumClientService()
		for (const { address, type, definition } of listBundledMetadataForChain(1n)) {
			const entry = await identifyAddress(ethereum, undefined, address, false)
			assert.deepEqual({ type: entry.type, name: entry.name, entrySource: entry.entrySource }, { type, name: definition.name, entrySource: 'DarkFloristMetadata' })
		}
	})

	test('identifyAddress applies no bundled metadata type outside Ethereum mainnet', async () => {
		const ethereum = createGoerliEthereumClientServiceWithoutContracts()
		const addressByBundledType = new Map(listBundledMetadataForChain(1n).map(({ type, address }) => [type, address]))

		assert.deepEqual(Array.from(addressByBundledType.keys()).sort(), ['ERC1155', 'ERC20', 'ERC721', 'contract'])
		for (const [bundledType, address] of addressByBundledType) {
			const entry = await identifyAddress(ethereum, undefined, address, false)
			assert.deepEqual({ bundledType, type: entry.type, name: entry.name, entrySource: entry.entrySource }, { bundledType, type: 'contact', name: checksummedAddress(address), entrySource: 'OnChain' })
		}
	})

	// A bundled address must be an imitation target exactly on the chains where identifyAddress names it from the bundled metadata, or lookalikes of it go unflagged.
	test('identification and lookalike indexing agree on a bundled address on mainnet and on another chain', async () => {
		const isIndexedAsKnown = (chainId: bigint) => getKnownAddressIndexes([], chainId).some((index) => Array.from(index.values()).flat().some(({ address }) => address === WETH_ADDRESS))
		const identifiedFromBundledMetadata = async (ethereum: EthereumClientService) => (await identifyAddress(ethereum, undefined, WETH_ADDRESS, false)).entrySource === 'DarkFloristMetadata'

		const mainnet = createOfflineMainnetEthereumClientService()
		const goerli = createGoerliEthereumClientServiceWithoutContracts()

		assert.deepEqual({ identified: await identifiedFromBundledMetadata(mainnet), indexed: isIndexedAsKnown(mainnet.getChainId()) }, { identified: true, indexed: true })
		assert.deepEqual({ identified: await identifiedFromBundledMetadata(goerli), indexed: isIndexedAsKnown(goerli.getChainId()) }, { identified: false, indexed: false })
		assert.equal(goerli.getChainId(), GOERLI_CHAIN_ID)
	})
})

// Which chains the bundled metadata applies to is decided only in bundledMetadata.ts, so the modules that read it must use the chain aware accessors and never compare a chain id themselves.
describe('bundled metadata chain boundary', () => {
	const appSourceRoot = path.join(process.cwd(), 'app', 'ts')
	const bundledMetadataPath = path.join(appSourceRoot, 'background', 'bundledMetadata.ts')
	const listSourceFiles = (directory: string): readonly string[] => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const entryPath = path.join(directory, entry.name)
		if (entry.isDirectory()) return listSourceFiles(entryPath)
		return /\.tsx?$/.test(entry.name) ? [entryPath] : []
	})
	const getBundledMetadataValueImports = (filePath: string): readonly string[] => {
		const sourceFile = ts.createSourceFile(filePath, fs.readFileSync(filePath, 'utf8'), ts.ScriptTarget.Latest, true)
		return sourceFile.statements.flatMap((statement) => {
			if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return []
			if (path.resolve(path.dirname(filePath), statement.moduleSpecifier.text.replace(/\.js$/, '.ts')) !== bundledMetadataPath) return []
			const importClause = statement.importClause
			if (importClause === undefined || importClause.isTypeOnly) return []
			const namedBindings = importClause.namedBindings
			if (namedBindings === undefined) return importClause.name === undefined ? [] : [importClause.name.text]
			if (ts.isNamespaceImport(namedBindings)) return [`* as ${ namedBindings.name.text }`]
			return namedBindings.elements.filter((element) => !element.isTypeOnly).map((element) => (element.propertyName ?? element.name).text)
		})
	}
	const importers = listSourceFiles(appSourceRoot).flatMap((filePath) => {
		const valueImports = getBundledMetadataValueImports(filePath)
		return valueImports.length === 0 ? [] : [{ file: path.relative(appSourceRoot, filePath), valueImports, source: fs.readFileSync(filePath, 'utf8') }]
	})

	test('identification and lookalike indexing read bundled metadata through the chain aware accessors', () => {
		const valueImportsOf = (file: string) => importers.find((importer) => importer.file === file)?.valueImports
		assert.deepEqual(valueImportsOf(path.join('background', 'metadataUtils.ts')), ['findBundledMetadataForChain'])
		assert.deepEqual(valueImportsOf(path.join('background', 'lookalikeKnownAddresses.ts')), ['listBundledMetadataForChain'])
	})

	test('no module that reads bundled metadata compares a chain id with mainnet itself', () => {
		for (const { file, source } of importers) {
			const bundledMetadataChainChecks = source.split('\n').filter((line) => /BundledMetadata/.test(line) && /===\s*1n|1n\s*===/.test(line))
			assert.deepEqual({ file, bundledMetadataChainChecks }, { file, bundledMetadataChainChecks: [] })
		}
	})
})
