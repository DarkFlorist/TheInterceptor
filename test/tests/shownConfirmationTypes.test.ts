import * as assert from 'node:assert'
import { test } from 'bun:test'
import * as ts from 'typescript'

const repositoryRoot = new URL('../../', import.meta.url).pathname
const fixturePath = `${ repositoryRoot }test/fixtures/shownConfirmation/provenance.ts`

// Storage first paint cannot become confirmable by structural compatibility with a background response.
test('shown confirmations require background provenance before accessing a reviewed id or accepting', async () => {
	const configFile = ts.readConfigFile(`${ repositoryRoot }tsconfig.json`, ts.sys.readFile)
	const { options } = ts.parseJsonConfigFileContent(configFile.config, ts.sys, repositoryRoot)
	const program = ts.createProgram([fixturePath], { ...options, noEmit: true, rootDir: repositoryRoot })
	const fixture = program.getSourceFile(fixturePath)
	if (fixture === undefined) throw new Error('Missing shown-confirmation provenance fixture')
	const errorLines = ts.getPreEmitDiagnostics(program, fixture).flatMap((diagnostic) => diagnostic.start === undefined ? [] : [fixture.getLineAndCharacterOfPosition(diagnostic.start).line + 1])
	const expectedLines = (await Bun.file(fixturePath).text()).split('\n').flatMap((line, index) => line.includes('// expect-type-error') ? [index + 1] : [])
	assert.equal(expectedLines.length, 3)
	assert.deepEqual([...new Set(errorLines)].sort((first, second) => first - second), expectedLines)
})
