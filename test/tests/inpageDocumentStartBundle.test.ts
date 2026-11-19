import * as assert from 'assert'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'bun:test'
import { runInNewContext } from 'node:vm'
import { createSafeHostHarness } from '../fixtures/safeAppsHostHarness.js'
import { buildRuntimeEntrypoints } from '../../build/bundler.mts'
import { getManifestV2DocumentStartScriptPath, getPageWorldScriptPaths } from '../../app/ts/utils/contentScriptInjectionArtifacts.js'

test('one runtime build ships and embeds identical classic provider bytes per compatibility mode and preserves preparation promises', async () => {
	const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'interceptor-inpage-bundles-'))
	const root = process.cwd()
	const inpagePath = path.join(root, 'app/inpage/ts/inpage.ts')
	const documentStartPath = path.join(root, 'app/inpage/ts/document_start.ts')
	const preparationPath = path.join(root, 'app/inpage/ts/prepareSafeAppBootstrap.ts')
	try {
		const bundles = await buildRuntimeEntrypoints([inpagePath, documentStartPath, preparationPath], { outdir, root, inpagePath, documentStartPath })
		const readBundle = (entrypointPath: string) => {
			const bundle = bundles.find((candidate) => candidate.entrypointPath === entrypointPath)
			assert.ok(bundle)
			return fs.readFileSync(bundle.bundledEntrypointPath, 'utf8')
		}
		for (const metamaskCompatibilityMode of [false, true]) {
			const providerPath = getPageWorldScriptPaths(metamaskCompatibilityMode)[0]
			assert.ok(providerPath)
			const provider = readBundle(path.join(root, providerPath))
			assert.match(provider, new RegExp(`metamaskCompatibilityModeAtPageLoad = ${ metamaskCompatibilityMode }`))
			let embeddedProvider: string | undefined
			const script = { setAttribute: () => undefined, hasAttribute: () => true, textContent: '' }
			const container = { children: [], insertBefore: () => { embeddedProvider = script.textContent }, removeChild: () => undefined }
			runInNewContext(readBundle(path.join(root, getManifestV2DocumentStartScriptPath(metamaskCompatibilityMode))), {
				[Symbol.for('TheInterceptor.listenContentScript')]: () => undefined,
				document: { head: container, createElement: () => script },
				browser: { runtime: {} },
			})
			// The inline script marks itself before running the provider, so a CSP-blocked provider can fall back to its extension URL.
			assert.ok(embeddedProvider?.endsWith(`\n${ provider }`))
			let setupReached = false
			const providerWindow = new Proxy({}, { get: (_target, property) => {
				if (property === 'postMessage') return () => undefined
				if (property === 'setTimeout' || property === 'clearTimeout') return () => undefined
				if (property === 'addEventListener') return () => { setupReached = true; throw new Error('Fixture reached provider setup') }
				return undefined
			} })
			assert.throws(() => runInNewContext(provider, { window: providerWindow }), /Fixture reached provider setup/)
			assert.equal(setupReached, true)
			assert.doesNotMatch(provider, /^import\s/m)
		}
		// Use the production bundler, not a separate build with different format/resolution options.
		const { fakeWindow, emitMessage, restoreGlobals } = createSafeHostHarness()
		try {
			fakeWindow.addEventListener('message', (event) => {
				if (!('data' in event) || typeof event.data !== 'object' || event.data === null || !('method' in event.data) || event.data.method !== 'getSafeInfo' || !('id' in event.data)) return
				emitMessage({ id: event.data.id, success: true })
			})
			const completion: unknown = runInNewContext(readBundle(preparationPath), { window: fakeWindow, crypto })
			assert.deepEqual(await completion, { success: true })
		} finally { restoreGlobals() }
	} finally { fs.rmSync(outdir, { recursive: true, force: true }) }
})
