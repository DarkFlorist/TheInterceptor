import * as assert from 'assert'
import * as fs from 'node:fs'
import { test } from 'bun:test'
import { contentScriptDocumentMarkers, type ContentScriptWorld } from '../../app/ts/utils/contentScriptDocumentMarkers.js'

// inpage.ts and listenContentScriptBootstrap.ts are standalone classic scripts that cannot import contentScriptDocumentMarkers.ts, so their copies of the keys are checked here.
const guardedScripts: { readonly [world in ContentScriptWorld]: string } = { MAIN: 'app/inpage/ts/inpage.ts', ISOLATED: 'app/inpage/ts/listenContentScriptBootstrap.ts' }

test('the provider and the bridge guard themselves with exactly the shared document markers of their world', () => {
	for (const world of ['MAIN', 'ISOLATED'] as const) {
		const { global, claimedKey, disabledOriginKey } = contentScriptDocumentMarkers[world]
		const source = fs.readFileSync(guardedScripts[world], 'utf8')
		const usedKeys = [...source.matchAll(/Symbol\.for\('(TheInterceptor\.[^']+)'\)/g)].map((match) => match[1])
		assert.deepEqual(new Set(usedKeys.filter((key) => key !== 'TheInterceptor.listenContentScript')), new Set([claimedKey, disabledOriginKey]), guardedScripts[world])
		assert.equal(source.includes(`Reflect.deleteProperty(${ global }, Symbol.for('${ disabledOriginKey }'))`), true, `${ guardedScripts[world] } consumes the disabled-origin marker on ${ global }`)
		assert.equal(source.includes(`Reflect.defineProperty(${ global }, Symbol.for('${ claimedKey }')`), true, `${ guardedScripts[world] } claims the document on ${ global }`)
	}
})

test('each world has its own markers, so a provider marker never guards the bridge', () => {
	const keys = Object.values(contentScriptDocumentMarkers).flatMap(({ claimedKey, disabledOriginKey }) => [claimedKey, disabledOriginKey])
	assert.equal(new Set(keys).size, keys.length)
})
