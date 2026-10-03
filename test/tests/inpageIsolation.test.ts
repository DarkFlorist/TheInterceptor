import * as assert from 'assert'
import * as path from 'node:path'
import { test } from 'bun:test'
import ts from 'typescript'
import { SAFE_APPS_REQUEST_METHOD } from '../../app/ts/types/safeRpcMethods.js'
import { SAFE_APPS_REQUEST_METHOD as INPAGE_SAFE_APPS_REQUEST_METHOD } from '../../app/inpage/ts/generated/safeRpcMethods.js'

function checkInpageImport(modulePath: string) {
	const configPath = path.resolve('tsconfig-inpage.json')
	const config = ts.readConfigFile(configPath, ts.sys.readFile)
	assert.equal(config.error, undefined)
	const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath))
	assert.deepEqual(parsed.errors, [])
	const fixturePath = path.resolve('app/inpage/ts/isolationFixture.ts')
	const host = ts.createCompilerHost(parsed.options)
	const readSourceFile = host.getSourceFile.bind(host)
	host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => fileName === fixturePath
		? ts.createSourceFile(fileName, `export { SAFE_APPS_REQUEST_METHOD } from '${ modulePath }'`, languageVersion)
		: readSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
	const program = ts.createProgram([fixturePath], parsed.options, host)
	return ts.getPreEmitDiagnostics(program)
}

test('inpage compiler accepts generated protocol data and rejects privileged source imports', () => {
	assert.equal(INPAGE_SAFE_APPS_REQUEST_METHOD, SAFE_APPS_REQUEST_METHOD)
	assert.deepEqual(checkInpageImport('./generated/safeRpcMethods.js'), [])
	const diagnostics = checkInpageImport('../../ts/types/safeRpcMethods.js')
	assert.ok(diagnostics.some((diagnostic) => diagnostic.code === 6059), 'Privileged imports must fail the inpage rootDir boundary')
}, 30000)
