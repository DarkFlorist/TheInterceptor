import * as assert from 'assert'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, test } from 'bun:test'
import * as ts from 'typescript'

const builderPath = 'app/ts/background/simulationInputBuilding.ts'

// Relative modules a file loads at runtime; type-only imports and exports are erased, so they cannot reach storage.
const getRuntimeRelativeImports = (filePath: string) => {
	const sourceFile = ts.createSourceFile(filePath, fs.readFileSync(filePath, 'utf8'), ts.ScriptTarget.Latest, true)
	return sourceFile.statements.flatMap((statement) => {
		if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) return []
		if (statement.moduleSpecifier === undefined || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.moduleSpecifier.text.startsWith('.')) return []
		if (ts.isImportDeclaration(statement) ? statement.importClause?.isTypeOnly === true : statement.isTypeOnly) return []
		const resolved = path.normalize(path.join(path.dirname(filePath), statement.moduleSpecifier.text.replace(/\.js$/u, '')))
		return [fs.existsSync(`${ resolved }.ts`) ? `${ resolved }.ts` : `${ resolved }.tsx`]
	})
}

const getRuntimeModuleClosure = (entryPath: string) => {
	const visited = new Set<string>()
	const pending = [path.normalize(entryPath)]
	while (pending.length > 0) {
		const next = pending.pop()
		if (next === undefined || visited.has(next)) continue
		visited.add(next)
		pending.push(...getRuntimeRelativeImports(next))
	}
	return [...visited]
}

// The storage owners and their helpers (storageUtils, storageVariables, addressBookStorage, settingsStorageTransaction, settings, richModeSettings); none of them may be loaded by the storage-free simulation input builder.
const isStorageModule = (modulePath: string) => {
	const fileName = path.basename(modulePath)
	return /storage/iu.test(fileName) || fileName === 'settings.ts' || fileName === 'richModeSettings.ts'
}

describe('simulation input builder purity', () => {
	test('simulationInputBuilding loads neither richModeSettings nor any storage module, directly or transitively', () => {
		const closure = getRuntimeModuleClosure(builderPath)
		assert.equal(closure.some((modulePath) => modulePath.endsWith('richModeDerivation.ts')), true, 'the builder derives rich-mode overrides from the pure module')
		assert.deepEqual(closure.filter(isStorageModule), [])
	})
})
