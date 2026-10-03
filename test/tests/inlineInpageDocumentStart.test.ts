import * as assert from 'assert'
import { test } from 'bun:test'
import * as ts from 'typescript'
import { getMetamaskCompatibilityModeGlobalAssignmentSource, getManifestV2IsolatedWorldInjections, metamaskCompatibilityModeGlobalSymbolKey } from '../../app/ts/config/contentScriptInjectionArtifacts.js'
import { metamaskCompatibilityModeGlobalAssignmentMarker, metamaskCompatibilityModeGlobalSymbolKeyMarker } from '../../scripts/content-script-injection-markers.mts'
import { inlineContentScriptInjectionConfiguration, inlineDocumentStartInjectionConfiguration, inlineMetamaskCompatibilityModeGlobalAssignment } from '../../scripts/inline-inpage-document-start.mts'

test('generated page-world scripts share the configured compatibility mode symbol key', async () => {
	for (const sourceFileName of ['document_start.ts', 'inpage.ts']) {
		const source = await Bun.file(new URL(`../../app/inpage/ts/${ sourceFileName }`, import.meta.url)).text()
		const generatedSource = inlineContentScriptInjectionConfiguration(source, sourceFileName.replace(/\.ts$/, '.js'))
		assert.equal(generatedSource.includes(`Symbol.for(${ JSON.stringify(metamaskCompatibilityModeGlobalSymbolKey) })`), true)
		assert.equal(generatedSource.includes(metamaskCompatibilityModeGlobalSymbolKeyMarker), false)
	}
})

test('page-world and isolated-world compatibility bootstraps share one generated assignment', async () => {
	const source = await Bun.file(new URL('../../app/inpage/ts/metamaskCompatibilityMode.ts', import.meta.url)).text()
	const compiledSource = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.ESNext,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText
	const generatedPageWorldSource = inlineMetamaskCompatibilityModeGlobalAssignment(compiledSource).trim()
	const isolatedWorldSource = getManifestV2IsolatedWorldInjections(true).find((injection) => 'code' in injection)?.code
	assert.equal(generatedPageWorldSource, getMetamaskCompatibilityModeGlobalAssignmentSource(true))
	assert.equal(isolatedWorldSource, generatedPageWorldSource)
	assert.equal(generatedPageWorldSource.includes(metamaskCompatibilityModeGlobalAssignmentMarker), false)
})

test('MV2 loads the configured external page-world scripts in both compatibility modes', async () => {
	const documentStartTypeScript = await Bun.file(new URL('../../app/inpage/ts/document_start.ts', import.meta.url)).text()
	const compiledDocumentStart = ts.transpileModule(documentStartTypeScript, {
		compilerOptions: {
			module: ts.ModuleKind.ESNext,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText
	const generatedDocumentStart = inlineDocumentStartInjectionConfiguration(compiledDocumentStart)
	for (const metamaskCompatibilityMode of [false, true]) {
		type ScriptEvent = 'load' | 'error'
		type FakeScript = { async: boolean, src: string, textContent: string, parentNode: ScriptContainer | undefined, addEventListener: (type: ScriptEvent, listener: () => void) => void }
		type ScriptContainer = { readonly children: readonly object[], insertBefore: (script: FakeScript) => void, removeChild: (script: FakeScript) => void }
		const injectedScripts: FakeScript[] = []
		const removedScripts: FakeScript[] = []
		const scriptListeners = new Map<FakeScript, Map<ScriptEvent, () => void>>()
		const fakeGlobalThis = {
			[Symbol.for('TheInterceptor.listenContentScript')]: () => undefined,
			[Symbol.for('TheInterceptor.metamaskCompatibilityMode')]: metamaskCompatibilityMode,
		}
		const scriptContainer: ScriptContainer = {
			children: [{}, {}],
			insertBefore: (script: FakeScript) => {
				script.parentNode = scriptContainer
				injectedScripts.push(script)
			},
			removeChild: (script: FakeScript) => {
				script.parentNode = undefined
				removedScripts.push(script)
			},
		}
		const fakeDocument = {
			head: scriptContainer,
			documentElement: scriptContainer,
			createElement: () => {
				const listeners = new Map<ScriptEvent, () => void>()
				const script: FakeScript = {
					async: true,
					src: '',
					textContent: '',
					parentNode: undefined,
					addEventListener: (type, listener) => { listeners.set(type, listener) },
				}
				scriptListeners.set(script, listeners)
				return script
			},
		}
		const fakeBrowser = {
			runtime: {
				getURL: (path: string) => `browser-extension://test/${ path }`,
				lastError: undefined,
			},
		}

		new Function('globalThis', 'browser', 'document', 'console', generatedDocumentStart)(fakeGlobalThis, fakeBrowser, fakeDocument, console)

		const expectedScriptPaths = [
			...(metamaskCompatibilityMode ? ['inpage/js/metamaskCompatibilityMode.js'] : []),
			'inpage/js/inpage.js',
		]
		assert.deepEqual(injectedScripts.map(({ async, src, textContent }) => ({ async, src, textContent })), expectedScriptPaths.map((scriptPath) => ({
			async: false,
			src: `browser-extension://test/${ scriptPath }`,
			textContent: '',
		})))
		assert.deepEqual(removedScripts, [])
		for (const [index, script] of injectedScripts.entries()) scriptListeners.get(script)?.get(index % 2 === 0 ? 'load' : 'error')?.()
		assert.deepEqual(removedScripts, injectedScripts)
	}
})
