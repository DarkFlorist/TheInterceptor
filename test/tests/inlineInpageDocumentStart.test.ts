import * as assert from 'assert'
import { test } from 'bun:test'
import * as ts from 'typescript'
import { metamaskCompatibilityModeGlobalSymbolKey, metamaskCompatibilityModeGlobalSymbolKeyMarker } from '../../app/ts/utils/contentScriptInjectionArtifacts.js'
import { inlineContentScriptInjectionConfiguration, inlineDocumentStartInjectionConfiguration } from '../../scripts/inline-inpage-document-start.mts'

test('build-facing content-script artifacts remain independent of runtime modules', async () => {
	const source = await Bun.file(new URL('../../app/ts/utils/contentScriptInjectionArtifacts.ts', import.meta.url)).text()
	const sourceFile = ts.createSourceFile('contentScriptInjectionArtifacts.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
	const staticDependencies: string[] = []
	for (const statement of sourceFile.statements) {
		if (ts.isImportDeclaration(statement)) staticDependencies.push(statement.moduleSpecifier.getText(sourceFile))
		if (ts.isImportEqualsDeclaration(statement)) staticDependencies.push(statement.moduleReference.getText(sourceFile))
		if (ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined) staticDependencies.push(statement.moduleSpecifier.getText(sourceFile))
	}
	assert.deepEqual(staticDependencies, [])
})

test('generated page-world scripts share the configured compatibility mode symbol key', async () => {
	for (const sourceFileName of ['document_start.ts', 'inpage.ts', 'metamaskCompatibilityMode.ts']) {
		const source = await Bun.file(new URL(`../../app/inpage/ts/${ sourceFileName }`, import.meta.url)).text()
		const generatedSource = inlineContentScriptInjectionConfiguration(source, sourceFileName.replace(/\.ts$/, '.js'))
		assert.equal(generatedSource.includes(`Symbol.for(${ JSON.stringify(metamaskCompatibilityModeGlobalSymbolKey) })`), true)
		assert.equal(generatedSource.includes(metamaskCompatibilityModeGlobalSymbolKeyMarker), false)
	}
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
		const injectedScripts: { readonly async: boolean, readonly src: string, readonly textContent: string }[] = []
		const fakeGlobalThis = {
			[Symbol.for('TheInterceptor.listenContentScript')]: () => undefined,
			[Symbol.for('TheInterceptor.metamaskCompatibilityMode')]: metamaskCompatibilityMode,
		}
		const scriptContainer = {
			children: [{}, {}],
			insertBefore: (script: { readonly async: boolean, readonly src: string, readonly textContent: string }) => {
				injectedScripts.push({ async: script.async, src: script.src, textContent: script.textContent })
			},
			removeChild: () => undefined,
		}
		const fakeDocument = {
			head: scriptContainer,
			documentElement: scriptContainer,
			createElement: () => ({ async: true, src: '', textContent: '' }),
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
		assert.deepEqual(injectedScripts, expectedScriptPaths.map((scriptPath) => ({
			async: false,
			src: `browser-extension://test/${ scriptPath }`,
			textContent: '',
		})))
	}
})
