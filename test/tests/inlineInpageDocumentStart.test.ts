import * as assert from 'assert'
import { test } from 'bun:test'
import * as ts from 'typescript'
import { metamaskCompatibilityModeGlobalSymbolKey } from '../../app/ts/config/contentScriptInjectionArtifacts.js'
import { metamaskCompatibilityModeAtPageLoadMarker, metamaskCompatibilityModeGlobalSymbolKeyMarker } from '../../scripts/content-script-injection-markers.mts'
import { inlineContentScriptInjectionConfiguration, inlineDocumentStartInjectionConfiguration, inlineMetamaskCompatibilityModeAtPageLoad } from '../../scripts/inline-inpage-document-start.mts'

test('generated isolated-world bootstrap uses the configured compatibility mode symbol key', async () => {
	const source = await Bun.file(new URL('../../app/inpage/ts/document_start.ts', import.meta.url)).text()
	const generatedSource = inlineContentScriptInjectionConfiguration(source, 'document_start.js')
	assert.equal(generatedSource.includes(`Symbol.for(${ JSON.stringify(metamaskCompatibilityModeGlobalSymbolKey) })`), true)
	assert.equal(generatedSource.includes(metamaskCompatibilityModeGlobalSymbolKeyMarker), false)
})

test('page-world compatibility mode is embedded as a build-time boolean', async () => {
	const source = await Bun.file(new URL('../../app/inpage/ts/inpage.ts', import.meta.url)).text()
	const compiledSource = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.ESNext,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText
	for (const metamaskCompatibilityMode of [false, true]) {
		const generatedPageWorldSource = inlineMetamaskCompatibilityModeAtPageLoad(compiledSource, metamaskCompatibilityMode)
		assert.equal(generatedPageWorldSource.includes(`const metamaskCompatibilityModeAtPageLoad = ${ metamaskCompatibilityMode }`), true)
		assert.equal(generatedPageWorldSource.includes(metamaskCompatibilityModeAtPageLoadMarker), false)
		assert.equal(generatedPageWorldSource.includes('TheInterceptor.metamaskCompatibilityMode'), false)
	}
})

test('MV2 synchronously injects the configured page-world source in both compatibility modes', async () => {
	const documentStartTypeScript = await Bun.file(new URL('../../app/inpage/ts/document_start.ts', import.meta.url)).text()
	const inpageTypeScript = await Bun.file(new URL('../../app/inpage/ts/inpage.ts', import.meta.url)).text()
	const compiledDocumentStart = ts.transpileModule(documentStartTypeScript, {
		compilerOptions: {
			module: ts.ModuleKind.ESNext,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText
	const compiledInpage = ts.transpileModule(inpageTypeScript, {
		compilerOptions: {
			module: ts.ModuleKind.ESNext,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText
	const generatedDocumentStart = inlineDocumentStartInjectionConfiguration(compiledDocumentStart, compiledInpage)
	for (const metamaskCompatibilityMode of [false, true]) {
		type FakeScript = { textContent: string }
		const injectionEvents: { readonly type: 'insert' | 'remove', readonly script: FakeScript }[] = []
		const fakeGlobalThis = {
			[Symbol.for('TheInterceptor.listenContentScript')]: () => undefined,
			[Symbol.for('TheInterceptor.metamaskCompatibilityMode')]: metamaskCompatibilityMode,
		}
		const scriptContainer = {
			children: [{}, {}],
			insertBefore: (script: FakeScript) => {
				injectionEvents.push({ type: 'insert', script })
			},
			removeChild: (script: FakeScript) => {
				injectionEvents.push({ type: 'remove', script })
			},
		}
		const fakeDocument = {
			head: scriptContainer,
			documentElement: scriptContainer,
			createElement: () => ({ textContent: '' }),
		}
		const fakeBrowser = {
			runtime: {
				lastError: undefined,
			},
		}

		new Function('globalThis', 'browser', 'document', 'console', generatedDocumentStart)(fakeGlobalThis, fakeBrowser, fakeDocument, console)

		const expectedSource = inlineMetamaskCompatibilityModeAtPageLoad(compiledInpage, metamaskCompatibilityMode)
		assert.equal(injectionEvents.length, 2)
		assert.equal(injectionEvents[0]?.type, 'insert')
		assert.equal(injectionEvents[0]?.script.textContent, expectedSource)
		assert.equal(injectionEvents[1]?.type, 'remove')
		assert.strictEqual(injectionEvents[1]?.script, injectionEvents[0]?.script)
	}
})
