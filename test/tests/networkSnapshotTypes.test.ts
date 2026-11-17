import { test } from 'bun:test'
import * as assert from 'node:assert'
import * as ts from 'typescript'

const repositoryRoot = new URL('../../', import.meta.url).pathname
const fixturePath = `${ repositoryRoot }test/fixtures/networkSnapshots/admission.ts`

// A held client can be replaced while it waits for the lock. Every caller must handle that absence before using the coherent-snapshot API.
test('held-service reads require an absence check and cannot brand pending or replaced reads as coherent snapshots', async () => {
	const configFile = ts.readConfigFile(`${ repositoryRoot }tsconfig.json`, ts.sys.readFile)
	const { options } = ts.parseJsonConfigFileContent(configFile.config, ts.sys, repositoryRoot)
	const program = ts.createProgram([fixturePath], { ...options, noEmit: true, rootDir: repositoryRoot })
	const fixture = program.getSourceFile(fixturePath)
	if (fixture === undefined) throw new Error('Missing network snapshot admission fixture')
	const errorLines = ts.getPreEmitDiagnostics(program, fixture).flatMap((diagnostic) => diagnostic.start === undefined ? [] : [fixture.getLineAndCharacterOfPosition(diagnostic.start).line + 1])
	const expectedLines = (await Bun.file(fixturePath).text()).split('\n').flatMap((line, index) => line.includes('// expect-type-error') ? [index + 1] : [])
	assert.equal(expectedLines.length, 3)
	assert.deepEqual([...new Set(errorLines)].sort((first, second) => first - second), expectedLines)
})
