import * as assert from 'assert'
import { test } from 'bun:test'
import * as ts from 'typescript'
import { inlineInpageSourceIntoDocumentStart } from '../../scripts/inline-inpage-document-start.mts'

test('active MV2 compatibility mode keeps both generated page-world scripts external and ordered', async () => {
	const documentStartTypeScript = await Bun.file(new URL('../../app/inpage/ts/document_start.ts', import.meta.url)).text()
	const compiledDocumentStart = ts.transpileModule(documentStartTypeScript, {
		compilerOptions: {
			module: ts.ModuleKind.ESNext,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText
	const generatedDocumentStart = inlineInpageSourceIntoDocumentStart(compiledDocumentStart, 'globalThis.unexpectedInlineInpageExecution = true')
	const injectedScripts: { readonly async: boolean, readonly src: string, readonly textContent: string }[] = []
	const fakeGlobalThis = {
		[Symbol.for('TheInterceptor.listenContentScript')]: () => undefined,
		[Symbol.for('TheInterceptor.metamaskCompatibilityMode')]: true,
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

	assert.deepEqual(injectedScripts, [{
		async: false,
		src: 'browser-extension://test/inpage/js/metamaskCompatibilityMode.js',
		textContent: '',
	}, {
		async: false,
		src: 'browser-extension://test/inpage/js/inpage.js',
		textContent: '',
	}])
	assert.equal('unexpectedInlineInpageExecution' in fakeGlobalThis, false)
})
