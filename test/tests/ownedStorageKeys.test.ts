import * as assert from 'node:assert'
import { test } from 'bun:test'
import * as ts from 'typescript'
import { isRecord } from '../../app/ts/utils/runtimeTypeGuards.js'

const repositoryRoot = new URL('../../', import.meta.url).pathname
const fixturePath = `${ repositoryRoot }test/fixtures/ownedStorageKeys/genericHelpers.ts`

// The pending requests and the reply outbox are written together in one storage transaction by their owners (storageVariables.ts and pendingTerminalReplies.ts); the generic storage helpers must not reach either key, or a write could bypass the transaction's lock.
test('the generic storage helpers cannot read or write the keys of the pending-request storage transaction', async () => {
	const configFile = ts.readConfigFile(`${ repositoryRoot }tsconfig.json`, ts.sys.readFile)
	const { options } = ts.parseJsonConfigFileContent(configFile.config, ts.sys, repositoryRoot)
	const program = ts.createProgram([fixturePath], { ...options, noEmit: true, rootDir: repositoryRoot })
	const fixture = program.getSourceFile(fixturePath)
	if (fixture === undefined) throw new Error('Missing owned storage keys fixture')
	const errorLines = ts.getPreEmitDiagnostics(program, fixture).flatMap((diagnostic) => diagnostic.start === undefined ? [] : [fixture.getLineAndCharacterOfPosition(diagnostic.start).line + 1])
	const expectedLines = (await Bun.file(fixturePath).text()).split('\n').flatMap((line, index) => line.includes('// expect-type-error') ? [index + 1] : [])
	assert.equal(expectedLines.length, 9)
	assert.deepEqual([...new Set(errorLines)].sort((first, second) => first - second), expectedLines)
})

test('the generic storage codecs drop the pending-request transaction keys and every generic helper refuses them before touching storage', async () => {
	const { browserStorageLocalGet, browserStorageLocalRemove, browserStorageLocalSafeParse, browserStorageLocalSafeParseGet, browserStorageLocalSet } = await import('../../app/ts/utils/storageUtils.js')
	assert.deepEqual(browserStorageLocalSafeParse({ simulationMode: true, pendingTerminalReplies: 'outbox', pendingTransactionsAndMessages: 'requests' }), { simulationMode: true })
	const storageCalls: string[] = []
	const recordStorageCall = (name: string) => async () => { storageCalls.push(name); return {} }
	const previousBrowser = Object.getOwnPropertyDescriptor(globalThis, 'browser')
	Object.defineProperty(globalThis, 'browser', { configurable: true, writable: true, value: { storage: { local: { get: recordStorageCall('get'), set: recordStorageCall('set'), remove: recordStorageCall('remove') } } } })
	try {
		// Values the type system refuses are what a caller that cast around it would pass; key lists that mix in an allowed key are refused too.
		const ownedKeyRequests: readonly unknown[] = ['pendingTerminalReplies', 'pendingTransactionsAndMessages', ['simulationMode', 'pendingTerminalReplies'], ['pendingTransactionsAndMessages']]
		for (const keys of ownedKeyRequests) {
			if (typeof keys !== 'string' && !(Array.isArray(keys) && keys.every((key) => typeof key === 'string'))) throw new Error('Expected storage keys')
			const keyList: string[] = typeof keys === 'string' ? [keys] : keys
			for (const helper of [browserStorageLocalGet, browserStorageLocalSafeParseGet, browserStorageLocalRemove]) {
				await assert.rejects(Reflect.apply(helper, undefined, [keyList]), /read and written only by their owners/u)
			}
		}
		const ownedKeyWrites: readonly unknown[] = [{ pendingTerminalReplies: [] }, { pendingTransactionsAndMessages: [] }]
		for (const items of ownedKeyWrites) {
			if (!isRecord(items)) throw new Error('Expected storage items')
			await assert.rejects(browserStorageLocalSet(items), /read and written only by their owners/u)
		}
		assert.deepEqual(storageCalls, [])
	} finally {
		if (previousBrowser === undefined) Reflect.deleteProperty(globalThis, 'browser')
		else Object.defineProperty(globalThis, 'browser', previousBrowser)
	}
})
