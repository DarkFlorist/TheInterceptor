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

test('MV2 synchronously injects the configured page-world source in both compatibility modes', async () => {
	const documentStartTypeScript = await Bun.file(new URL('../../app/inpage/ts/document_start.ts', import.meta.url)).text()
	const inpageTypeScript = await Bun.file(new URL('../../app/inpage/ts/inpage.ts', import.meta.url)).text()
	const metamaskCompatibilityModeTypeScript = await Bun.file(new URL('../../app/inpage/ts/metamaskCompatibilityMode.ts', import.meta.url)).text()
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
	const compiledMetamaskCompatibilityMode = ts.transpileModule(metamaskCompatibilityModeTypeScript, {
		compilerOptions: {
			module: ts.ModuleKind.ESNext,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText
	const generatedInpage = inlineContentScriptInjectionConfiguration(compiledInpage, 'inpage.js')
	const generatedMetamaskCompatibilityMode = inlineMetamaskCompatibilityModeGlobalAssignment(compiledMetamaskCompatibilityMode)
	const generatedDocumentStart = inlineDocumentStartInjectionConfiguration(compiledDocumentStart, compiledInpage, compiledMetamaskCompatibilityMode)
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

		const expectedSource = metamaskCompatibilityMode ? `${ generatedMetamaskCompatibilityMode }\n${ generatedInpage }` : generatedInpage
		assert.equal(injectionEvents.length, 2)
		assert.equal(injectionEvents[0]?.type, 'insert')
		assert.equal(injectionEvents[0]?.script.textContent, expectedSource)
		assert.equal(injectionEvents[1]?.type, 'remove')
		assert.strictEqual(injectionEvents[1]?.script, injectionEvents[0]?.script)
	}
})
