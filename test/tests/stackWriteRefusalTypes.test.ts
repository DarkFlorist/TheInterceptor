import * as assert from 'node:assert'
import { test } from 'bun:test'
import ts from 'typescript'

const repositoryRoot = new URL('../../', import.meta.url).pathname
const fixturePath = `${ repositoryRoot }app/ts/background/stackWriteRefusalTypeFixture.ts`
const fixtureSource = [
	`import { updateInterceptorTransactionStackUnlessRefused } from './storageVariables.js'`,
	`export const synchronousRefusal = updateInterceptorTransactionStackUnlessRefused((_stack, settingsSnapshot) => settingsSnapshot.settings.simulationMode ? undefined : { reason: 'signingMode' as const }, (stack) => stack)`,
	`export const awaitingRefusal = updateInterceptorTransactionStackUnlessRefused(async () => ({ reason: 'awaited' as const }), (stack) => stack)`,
].join('\n')

// Type-checks an in-memory module next to storageVariables.ts with the app's compiler options, so the check sees the exported signature exactly as app code does.
function getFixtureDiagnosticLines() {
	const configFile = ts.readConfigFile(`${ repositoryRoot }tsconfig.json`, ts.sys.readFile)
	const { options } = ts.parseJsonConfigFileContent(configFile.config, ts.sys, repositoryRoot)
	const host = ts.createCompilerHost(options)
	const readSourceFile = host.getSourceFile
	host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => fileName === fixturePath
		? ts.createSourceFile(fileName, fixtureSource, languageVersion)
		: readSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
	host.fileExists = (fileName) => fileName === fixturePath || ts.sys.fileExists(fileName)
	const program = ts.createProgram([fixturePath], { ...options, noEmit: true }, host)
	const fixture = program.getSourceFile(fixturePath)
	if (fixture === undefined) throw new Error('The type fixture was not loaded')
	return program.getSemanticDiagnostics(fixture).map((diagnostic) => diagnostic.start === undefined ? -1 : fixture.getLineAndCharacterOfPosition(diagnostic.start).line)
}

test('a conditional simulation stack write cannot take a refusal decision that awaits', () => {
	// Line 1 decides synchronously and type-checks; line 2 passes an async decision, which the signature rejects, so no caller I/O can run under the stack's write lock.
	assert.deepEqual([...new Set(getFixtureDiagnosticLines())], [2])
}, 60_000)
