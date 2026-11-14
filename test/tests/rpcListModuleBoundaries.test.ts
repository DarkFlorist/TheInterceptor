import * as assert from 'node:assert'
import { test } from 'bun:test'

const appSourceDirectory = new URL('../../app/ts/', import.meta.url).pathname
const appSources = new Map<string, string>()
for await (const file of new Bun.Glob('**/*.{ts,tsx}').scan({ cwd: appSourceDirectory })) appSources.set(file, await Bun.file(`${ appSourceDirectory }${ file }`).text())

const importsModule = (source: string, moduleFileName: string) => new RegExp(`from '(?:\\.\\.?/)+(?:[\\w-]+/)*${ moduleFileName.replace('.', '\\.') }'`, 'u').test(source)

test('the stored RPC list does not depend on popup messaging', () => {
	const storageSource = appSources.get('background/rpcListStorage.ts')
	assert.ok(storageSource !== undefined)
	assert.equal(importsModule(storageSource, 'backgroundUtils.js'), false)
	assert.doesNotMatch(storageSource, /sendPopupMessage/u)
})

test('only background/rpcList.ts writes the stored RPC list, so every write is broadcast to open pages', () => {
	const writers = [...appSources].filter(([file, source]) => file !== 'background/rpcListStorage.ts' && /\brpcListStorageWriter\b/u.test(source)).map(([file]) => file)
	assert.deepEqual(writers, ['background/rpcList.ts'])
})

test('read-only RPC lookups import the storage module, not the broadcast module', () => {
	const broadcastModuleImporters = [...appSources].filter(([, source]) => importsModule(source, 'rpcList.js')).map(([file]) => file).sort()
	// Only code that writes the list or answers a page's request for it needs the broadcast module.
	assert.deepEqual(broadcastModuleImporters, ['background/popupMessageHandlerRegistries/settings.ts', 'background/popupMessageHandlers/settings.ts', 'background/walletSwitch.ts'])
})
