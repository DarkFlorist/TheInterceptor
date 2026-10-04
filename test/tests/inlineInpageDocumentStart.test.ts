import * as assert from 'assert'
import { test } from 'bun:test'
import * as ts from 'typescript'
import { getPageWorldScriptPaths } from '../../app/ts/config/contentScriptInjectionArtifacts.js'
import { metamaskCompatibilityModeAtPageLoadMarker, pageWorldProviderScriptPathMarker } from '../../scripts/content-script-injection-markers.mts'
import { inlineDocumentStartInjectionConfiguration, inlineMetamaskCompatibilityModeAtPageLoad } from '../../scripts/inline-inpage-document-start.mts'

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

test('MV2 injects the configured external page-world artifact in both compatibility modes', async () => {
	const documentStartTypeScript = await Bun.file(new URL('../../app/inpage/ts/document_start.ts', import.meta.url)).text()
	const compiledDocumentStart = ts.transpileModule(documentStartTypeScript, {
		compilerOptions: {
			module: ts.ModuleKind.ESNext,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText
	for (const metamaskCompatibilityMode of [false, true]) {
		const generatedDocumentStart = inlineDocumentStartInjectionConfiguration(compiledDocumentStart, metamaskCompatibilityMode)
		type FakeScript = { src: string }
		const injectionEvents: { readonly type: 'insert' | 'remove', readonly script: FakeScript }[] = []
		const fakeGlobalThis = {
			[Symbol.for('TheInterceptor.listenContentScript')]: () => undefined,
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
			createElement: () => ({ src: '' }),
		}
		const fakeBrowser = {
			runtime: {
				lastError: undefined,
				getURL: (path: string) => `moz-extension://interceptor/${ path }`,
			},
		}

		new Function('globalThis', 'browser', 'document', 'console', generatedDocumentStart)(fakeGlobalThis, fakeBrowser, fakeDocument, console)

		assert.equal(injectionEvents.length, 2)
		assert.equal(injectionEvents[0]?.type, 'insert')
		assert.equal(injectionEvents[0]?.script.src, `moz-extension://interceptor/${ getPageWorldScriptPaths(metamaskCompatibilityMode)[0] }`)
		assert.equal(injectionEvents[1]?.type, 'remove')
		assert.strictEqual(injectionEvents[1]?.script, injectionEvents[0]?.script)
		assert.equal(generatedDocumentStart.includes(pageWorldProviderScriptPathMarker), false)
	}
})

test('MV2 leaves injection retryable when bootstrap prerequisites are missing', async () => {
	const documentStartTypeScript = await Bun.file(new URL('../../app/inpage/ts/document_start.ts', import.meta.url)).text()
	const compiledDocumentStart = ts.transpileModule(documentStartTypeScript, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
	const generatedDocumentStart = inlineDocumentStartInjectionConfiguration(compiledDocumentStart, false)
	const fakeGlobalThis: { interceptorInjected?: boolean } = {}
	const errors: unknown[] = []

	new Function('globalThis', 'browser', 'document', 'console', generatedDocumentStart)(fakeGlobalThis, { runtime: { lastError: undefined, getURL: (path: string) => path } }, {}, { error: (...args: unknown[]) => errors.push(args) })

	assert.equal(fakeGlobalThis.interceptorInjected, undefined)
	assert.equal(errors.length, 1)
})
