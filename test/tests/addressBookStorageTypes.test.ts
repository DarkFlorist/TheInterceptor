import * as assert from 'node:assert'
import { test } from 'bun:test'
import * as ts from 'typescript'

const repositoryRoot = new URL('../../', import.meta.url).pathname
const fixturePath = `${ repositoryRoot }test/fixtures/addressBookStorage/writes.ts`

// Name-store fields are derived from their codec, so new fields cannot silently take the general settings write path.
test('name stores require an explicit domain write directly and in atomic settings plans', async () => {
	const configFile = ts.readConfigFile(`${ repositoryRoot }tsconfig.json`, ts.sys.readFile)
	const { options } = ts.parseJsonConfigFileContent(configFile.config, ts.sys, repositoryRoot)
	const program = ts.createProgram([fixturePath], { ...options, noEmit: true, rootDir: repositoryRoot })
	const fixture = program.getSourceFile(fixturePath)
	if (fixture === undefined) throw new Error('Missing explicit address-book write fixture')
	const errorLines = ts.getPreEmitDiagnostics(program, fixture).flatMap((diagnostic) => diagnostic.start === undefined ? [] : [fixture.getLineAndCharacterOfPosition(diagnostic.start).line + 1])
	const expectedLines = (await Bun.file(fixturePath).text()).split('\n').flatMap((line, index) => line.includes('// expect-type-error') ? [index + 1] : [])
	assert.equal(expectedLines.length, 2)
	assert.deepEqual([...new Set(errorLines)].sort((first, second) => first - second), expectedLines)
})
