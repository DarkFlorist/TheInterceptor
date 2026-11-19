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

	test('exports only the chain aware accessors, the entry conversion and the explicitly chain independent token check', () => {
		assert.deepEqual(Object.keys(bundledMetadataModule).sort(), ['bundledMetadataToAddressBookEntry', 'findBundledMetadataForChain', 'isBundledTokenAddressOnAnyChain', 'listBundledAddressBookEntriesForChain', 'listBundledAddressBookEntriesForNameCollisionCheck', 'listBundledMetadataForChain'])
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

// Which chains the bundled metadata applies to, and how its definitions become address book entries, is decided only in bundledMetadata.ts: no other module reads the package, and modules that use the accessors pass them the chain they work on instead of choosing a chain themselves.
describe('bundled metadata chain boundary', () => {
	const BUNDLED_METADATA_PACKAGE_REFERENCE = /['"]@darkflorist\/address-metadata['"]/
	const appSourceRoot = path.join(process.cwd(), 'app', 'ts')
	const bundledMetadataPath = path.join(appSourceRoot, 'background', 'bundledMetadata.ts')
	const listSourceFiles = (directory: string): readonly string[] => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const entryPath = path.join(directory, entry.name)
		if (entry.isDirectory()) return listSourceFiles(entryPath)
		return /\.tsx?$/.test(entry.name) ? [entryPath] : []
	})
	const sourceFiles = listSourceFiles(appSourceRoot).map((filePath) => ({ filePath, file: path.relative(appSourceRoot, filePath), source: fs.readFileSync(filePath, 'utf8') }))
	type ValueImport = { readonly imported: string, readonly local: string }
	const getBundledMetadataValueImports = (sourceFile: ts.SourceFile, filePath: string): readonly ValueImport[] => sourceFile.statements.flatMap((statement) => {
		if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return []
		if (path.resolve(path.dirname(filePath), statement.moduleSpecifier.text.replace(/\.js$/, '.ts')) !== bundledMetadataPath) return []
		const importClause = statement.importClause
		if (importClause === undefined || importClause.isTypeOnly) return []
		const namedBindings = importClause.namedBindings
		if (namedBindings === undefined) return importClause.name === undefined ? [] : [{ imported: 'default', local: importClause.name.text }]
		if (ts.isNamespaceImport(namedBindings)) return [{ imported: '*', local: namedBindings.name.text }]
		return namedBindings.elements.filter((element) => !element.isTypeOnly).map((element) => ({ imported: (element.propertyName ?? element.name).text, local: element.name.text }))
	})
	const importers = sourceFiles.flatMap(({ filePath, file, source }) => {
		const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true)
		const valueImports = getBundledMetadataValueImports(sourceFile, filePath)
		return valueImports.length === 0 ? [] : [{ file, sourceFile, valueImports }]
	})
	const listNodes = (node: ts.Node): readonly ts.Node[] => [node, ...node.getChildren().flatMap(listNodes)]
	const listAccessorCalls = (sourceFile: ts.SourceFile, valueImports: readonly ValueImport[]) => {
		const localNames = new Set(valueImports.map(({ local }) => local))
		return listNodes(sourceFile).filter((node): node is ts.CallExpression => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && localNames.has(node.expression.text))
	}
	const isChainIdComparisonWithLiteral = (node: ts.Node) => {
		if (!ts.isBinaryExpression(node)) return false
		const operator = node.operatorToken.kind
		if (operator !== ts.SyntaxKind.EqualsEqualsEqualsToken && operator !== ts.SyntaxKind.ExclamationEqualsEqualsToken) return false
		const literalSide = ts.isBigIntLiteral(node.left) ? node.right : ts.isBigIntLiteral(node.right) ? node.left : undefined
		return literalSide !== undefined && /chainid/i.test(literalSide.getText())
	}

	test('only bundledMetadata.ts reads the bundled metadata package', () => {
		const packageReaders = sourceFiles.filter(({ source }) => BUNDLED_METADATA_PACKAGE_REFERENCE.test(source)).map(({ file }) => file)
		assert.deepEqual(packageReaders, [path.relative(appSourceRoot, bundledMetadataPath)])
	})

	test('address identification, search, lookalike indexing and the common token protector read bundled metadata through bundledMetadata.ts', () => {
		const importedNamesOf = (file: string) => importers.find((importer) => importer.file === file)?.valueImports.map(({ imported }) => imported)
		assert.deepEqual(importedNamesOf(path.join('background', 'metadataUtils.ts')), ['bundledMetadataToAddressBookEntry', 'findBundledMetadataForChain'])
		assert.deepEqual(importedNamesOf(path.join('background', 'metadataSearch.ts')), ['listBundledAddressBookEntriesForChain', 'listBundledAddressBookEntriesForNameCollisionCheck'])
		assert.deepEqual(importedNamesOf(path.join('background', 'lookalikeKnownAddresses.ts')), ['listBundledMetadataForChain'])
		assert.deepEqual(importedNamesOf(path.join('simulation', 'protectors', 'commonTokenOops.ts')), ['isBundledTokenAddressOnAnyChain'])
	})

	test('no module passes a literal chain to the accessors', () => {
		for (const { file, sourceFile, valueImports } of importers) {
			const literalArguments = listAccessorCalls(sourceFile, valueImports).flatMap((call) => call.arguments.filter((argument) => ts.isBigIntLiteral(argument) || ts.isNumericLiteral(argument) || ts.isStringLiteral(argument)).map((argument) => argument.getText()))
			assert.deepEqual({ file, literalArguments }, { file, literalArguments: [] })
		}
	})

	test('no function that calls an accessor compares a chain id with a literal itself', () => {
		for (const { file, sourceFile, valueImports } of importers) {
			const enclosingScopes = new Set(listAccessorCalls(sourceFile, valueImports).map((call) => ts.findAncestor(call.parent, ts.isFunctionLike) ?? sourceFile))
			const chainIdComparisons = Array.from(enclosingScopes).flatMap((scope) => listNodes(scope).filter(isChainIdComparisonWithLiteral).map((node) => node.getText()))
			assert.deepEqual({ file, chainIdComparisons }, { file, chainIdComparisons: [] })
		}
	})
})
