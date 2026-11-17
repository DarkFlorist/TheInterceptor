import * as assert from 'node:assert'
import { test } from 'bun:test'
import * as ts from 'typescript'
import { createEthereumWithGetBlockCounter, createPort, installBrowserMock, loadModules } from './backgroundEthAccountsTestHarness.js'

const repositoryRoot = new URL('../../', import.meta.url).pathname
const fixturePath = `${ repositoryRoot }test/fixtures/liveSettingsGrant/grants.ts`

test('a grant that awaits, or returns a promise, does not type-check', async () => {
	const configFile = ts.readConfigFile(`${ repositoryRoot }tsconfig.json`, ts.sys.readFile)
	const { options } = ts.parseJsonConfigFileContent(configFile.config, ts.sys, repositoryRoot)
	const program = ts.createProgram([fixturePath], { ...options, noEmit: true, rootDir: repositoryRoot })
	const fixture = program.getSourceFile(fixturePath)
	if (fixture === undefined) throw new Error('Missing live-settings grant fixture')
	const errorLines = ts.getPreEmitDiagnostics(program, fixture).flatMap((diagnostic) => diagnostic.start === undefined ? [] : [fixture.getLineAndCharacterOfPosition(diagnostic.start).line + 1])
	const expectedLines = (await Bun.file(fixturePath).text()).split('\n').flatMap((line, index) => line.includes('// expect-type-error') ? [index + 1] : [])
	assert.equal(expectedLines.length, 2)
	assert.deepEqual([...new Set(errorLines)].sort((first, second) => first - second), expectedLines)
})

test('live settings that escape their grant cannot grant later', async () => {
	installBrowserMock()
	const { getRequiredSettings, grantWithLiveSettings, verifyAccess, websiteSocketToString } = await loadModules()
	createEthereumWithGetBlockCounter({ count: 0 })
	const settings = await getRequiredSettings()
	const socket = { tabId: 1, connectionName: 0n }
	const { port } = createPort(socket.tabId)
	const websiteOrigin = 'https://escaped-grant.example.test'
	const websiteTabConnections = new Map([[socket.tabId, { connections: { [websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: false, wantsToConnect: true } } }]])

	const escaped = await grantWithLiveSettings(settings, (liveSettings) => liveSettings)
	if (escaped.kind !== 'granted') throw new Error('Expected the live settings to be read')

	assert.throws(() => verifyAccess(websiteTabConnections, socket, false, websiteOrigin, undefined, escaped.result), /outside the grant they were read for/u)
	assert.equal(websiteTabConnections.get(socket.tabId)?.connections[websiteSocketToString(socket)]?.approved, false)
})
