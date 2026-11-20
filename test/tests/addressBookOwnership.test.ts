import * as assert from 'assert'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, test } from 'bun:test'
import * as ts from 'typescript'

const addressBookStoragePath = path.normalize('app/ts/background/addressBookStorage.ts')
// storageUtils declares the stored-value codecs and types; it reads and parses keys but writes none itself.
const storageCodecRegistryPath = path.normalize('app/ts/utils/storageUtils.ts')

const listSourceFiles = (directory: string): string[] => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
	const entryPath = path.join(directory, entry.name)
	if (entry.isDirectory()) return listSourceFiles(entryPath)
	return /\.tsx?$/u.test(entry.name) ? [path.normalize(entryPath)] : []
})

const parse = (filePath: string) => ts.createSourceFile(filePath, fs.readFileSync(filePath, 'utf8'), ts.ScriptTarget.Latest, true)

const forEachDescendant = (node: ts.Node, visit: (descendant: ts.Node) => void) => {
	ts.forEachChild(node, (child) => {
		visit(child)
		forEachDescendant(child, visit)
	})
}

// Object literals that name the address-book storage key build storage items for it, which is a raw address-book write.
const buildsAddressBookStorageItems = (sourceFile: ts.SourceFile) => {
	let found = false
	forEachDescendant(sourceFile, (node) => {
		if (!ts.isObjectLiteralExpression(node)) return
		if (node.properties.some((property) => property.name !== undefined && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === 'userAddressBookEntriesV3')) found = true
	})
	return found
}

const sourceFiles = listSourceFiles('app/ts')

describe('address-book storage ownership', () => {
	test('only addressBookStorage builds address-book storage items, so no write can skip funding reconciliation', () => {
		assert.deepEqual(sourceFiles.filter((filePath) => filePath !== addressBookStoragePath && filePath !== storageCodecRegistryPath && buildsAddressBookStorageItems(parse(filePath))), [])
	})

	test('address-book reads never write: storage is written only inside settings storage transactions', () => {
		const ownerSourceFile = parse(addressBookStoragePath)
		assert.doesNotMatch(ownerSourceFile.text, /browserStorageLocalSet|storage\.local\.set\(/u)
		const readFunctionNames = ['getUserAddressBookEntries', 'readStoredUserAddressBookEntries', 'getUserAddressBookEntriesForChainId', 'getUserAddressBookEntriesForChainIdMorePreciseFirst']
		const readFunctions = ownerSourceFile.statements.flatMap((statement) => {
			if (ts.isFunctionDeclaration(statement) && statement.name !== undefined && readFunctionNames.includes(statement.name.text)) return [statement]
			if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.filter((declaration) => ts.isIdentifier(declaration.name) && readFunctionNames.includes(declaration.name.text))
			return []
		})
		assert.equal(readFunctions.length, readFunctionNames.length)
		for (const readFunction of readFunctions) assert.doesNotMatch(readFunction.getText(ownerSourceFile), /runSettingsStorageTransaction|StorageWrite|getFundingAwareAddressBookWrites/u)
	})

	test('addressBookStorage keeps its raw address-book write private and nothing re-exports it', () => {
		const ownerSource = fs.readFileSync(addressBookStoragePath, 'utf8')
		assert.match(ownerSource, /^const userAddressBookEntriesStorageWrite = /mu)
		const reExporters = sourceFiles.filter((filePath) => parse(filePath).statements.some((statement) => ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text.endsWith('/addressBookStorage.js')))
		assert.deepEqual(reExporters, [])
	})
})
