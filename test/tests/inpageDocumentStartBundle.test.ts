import * as assert from 'assert'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'bun:test'
import { runInNewContext } from 'node:vm'
import { buildRuntimeEntrypoints } from '../../build/bundler.mts'
import { getManifestV2DocumentStartScriptPath, getPageWorldScriptPaths } from '../../app/ts/utils/contentScriptInjectionArtifacts.js'

test('one runtime build ships and embeds identical classic provider bytes per compatibility mode', async () => {
	const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'interceptor-inpage-bundles-'))
	const root = process.cwd()
	const inpagePath = path.join(root, 'app/inpage/ts/inpage.ts')
	const documentStartPath = path.join(root, 'app/inpage/ts/document_start.ts')
	const extensionPath = path.join(root, 'app/inpage/ts/siteBehaviorBootstrap.ts')
	const scriptPath = 'inpage/js/siteBehaviorBootstrap.js'
	try {
		const bundles = await buildRuntimeEntrypoints([inpagePath, documentStartPath, extensionPath], { outdir, root, inpagePath, documentStartPath, pageWorldExtensions: [{ entrypointPath: extensionPath, scriptPath }] })
		const readBundle = (entrypointPath: string) => {
			const bundle = bundles.find((candidate) => candidate.entrypointPath === entrypointPath)
			assert.ok(bundle)
			return fs.readFileSync(bundle.bundledEntrypointPath, 'utf8')
		}
		const extension = bundles.find(({ entrypointPath }) => entrypointPath === extensionPath)
		assert.ok(extension)
		const extensionSource = fs.readFileSync(extension.bundledEntrypointPath, 'utf8')
		assert.match(extensionSource, /preparePortfolioApiInterception/)
		for (const metamaskCompatibilityMode of [false, true]) {
			const providerPath = getPageWorldScriptPaths(metamaskCompatibilityMode)[0]
			assert.ok(providerPath)
			const provider = readBundle(path.join(root, providerPath))
			assert.match(provider, new RegExp(`metamaskCompatibilityModeAtPageLoad = ${ metamaskCompatibilityMode }`))
			const embeddedScripts: string[] = []
			const script = { setAttribute: () => undefined, hasAttribute: () => true, textContent: '' }
			const container = { children: [], insertBefore: () => { embeddedScripts.push(script.textContent) }, removeChild: () => undefined }
			runInNewContext(readBundle(path.join(root, getManifestV2DocumentStartScriptPath(metamaskCompatibilityMode))), {
				[Symbol.for('TheInterceptor.listenContentScript')]: () => undefined,
				document: { head: container, createElement: () => script },
				browser: { runtime: {} },
			})
			// The inline script marks itself before running the provider, so a CSP-blocked provider can fall back to its extension URL.
			assert.ok(embeddedScripts[0]?.endsWith(`\n${ provider }`))
			assert.ok(embeddedScripts[1]?.endsWith(`\n${ extensionSource }`))
			let setupReached = false
			const providerWindow = new Proxy({}, { get: (_target, property) => {
				if (property === 'parent' || property === 'top') return providerWindow
				if (property === 'postMessage') return () => undefined
				if (property === 'setTimeout' || property === 'clearTimeout') return () => undefined
				if (property === 'addEventListener') return () => { setupReached = true; throw new Error('Fixture reached provider setup') }
				return undefined
			} })
			assert.throws(() => runInNewContext(provider, { window: providerWindow }), /Fixture reached provider setup/)
			assert.equal(setupReached, true)
			assert.doesNotMatch(provider, /^import\s/m)
			assert.doesNotMatch(provider, /preparePortfolioApiInterception|prepareBalanceApiInterception|installRpcReadInterception|app\.uniswap\.org/)
		}

	} finally { fs.rmSync(outdir, { recursive: true, force: true }) }
})
