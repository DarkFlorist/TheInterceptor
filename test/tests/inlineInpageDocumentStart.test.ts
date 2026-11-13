import * as assert from 'assert'
import { test } from 'bun:test'
import * as ts from 'typescript'
import { getManifestV2DocumentStartScriptPath, getPageWorldScriptPaths } from '../../app/ts/utils/contentScriptInjectionArtifacts.js'
import { metamaskCompatibilityModeAtPageLoadMarker, pageWorldProviderScriptPathMarker, pageWorldProviderSourceMarker } from '../../scripts/content-script-injection-markers.mts'
import { generateInpageArtifacts, inlineDocumentStartPageWorldProvider, inlineMetamaskCompatibilityModeAtPageLoad } from '../../scripts/inline-inpage-document-start.mts'

const compileClassicScript = async (sourcePath: string) => ts.transpileModule(await Bun.file(new URL(sourcePath, import.meta.url)).text(), {
	compilerOptions: {
		module: ts.ModuleKind.ESNext,
		target: ts.ScriptTarget.ES2022,
	},
}).outputText

const generateArtifactsFromSources = async () => generateInpageArtifacts(await compileClassicScript('../../app/inpage/ts/document_start.ts'), await compileClassicScript('../../app/inpage/ts/inpage.ts'))

const getArtifact = (artifacts: Awaited<ReturnType<typeof generateArtifactsFromSources>>, path: string) => {
	const artifact = artifacts.find((candidate) => candidate.path === path)
	if (artifact === undefined) throw new Error(`Missing generated artifact ${ path }`)
	return artifact
}

type FakeScriptElement = {
	src: string
	textContent: string
	readonly attributes: Set<string>
	setAttribute: (name: string, value: string) => void
	hasAttribute: (name: string) => boolean
}

const createFakeScriptElement = (): FakeScriptElement => {
	const attributes = new Set<string>()
	return { src: '', textContent: '', attributes, setAttribute: (name) => { attributes.add(name) }, hasAttribute: (name) => attributes.has(name) }
}

// Runs a generated MV2 document-start script against a fake page. Like a browser, inserting an inline script runs it synchronously in the page world, unless the page CSP blocks inline scripts; an external script is only queued, because a browser loads it asynchronously.
function runDocumentStart(documentStartSource: string, { pageCspBlocksInlineScripts }: { readonly pageCspBlocksInlineScripts: boolean }) {
	const pageWindow = Object.assign(new EventTarget(), { postMessage: () => undefined })
	const pageDocument: { currentScript: FakeScriptElement | undefined } = { currentScript: undefined }
	const insertedScripts: { readonly external: boolean, readonly ranSynchronously: boolean, readonly src: string }[] = []
	const scriptContainer = {
		children: [{}, {}],
		insertBefore: (script: FakeScriptElement) => {
			const runsInline = script.src === '' && !pageCspBlocksInlineScripts
			if (runsInline) {
				pageDocument.currentScript = script
				new Function('window', 'document', script.textContent)(pageWindow, pageDocument)
				pageDocument.currentScript = undefined
			}
			insertedScripts.push({ external: script.src !== '', ranSynchronously: runsInline, src: script.src })
		},
		removeChild: () => undefined,
	}
	const contentScriptGlobal: { interceptorInjected?: boolean, [key: symbol]: unknown } = { [Symbol.for('TheInterceptor.listenContentScript')]: () => undefined }
	const contentScriptDocument = { head: scriptContainer, documentElement: scriptContainer, createElement: createFakeScriptElement }
	const fakeBrowser = { runtime: { lastError: undefined, getURL: (path: string) => `moz-extension://interceptor/${ path }` } }
	const errors: unknown[] = []
	new Function('globalThis', 'browser', 'document', 'console', documentStartSource)(contentScriptGlobal, fakeBrowser, contentScriptDocument, { error: (...args: unknown[]) => errors.push(args) })
	return { pageWindow, insertedScripts, contentScriptGlobal, errors }
}

const isInterceptorProvider = (value: unknown) => typeof value === 'object' && value !== null && Reflect.get(value, 'isInterceptor') === true

test('page-world compatibility mode is embedded as a build-time boolean', async () => {
	const compiledSource = await compileClassicScript('../../app/inpage/ts/inpage.ts')
	for (const metamaskCompatibilityMode of [false, true]) {
		const generatedPageWorldSource = inlineMetamaskCompatibilityModeAtPageLoad(compiledSource, metamaskCompatibilityMode)
		assert.equal(generatedPageWorldSource.includes(`const metamaskCompatibilityModeAtPageLoad = ${ metamaskCompatibilityMode }`), true)
		assert.equal(generatedPageWorldSource.includes(metamaskCompatibilityModeAtPageLoadMarker), false)
		assert.equal(generatedPageWorldSource.includes('TheInterceptor.metamaskCompatibilityMode'), false)
	}
})

test('MV2 document-start defines window.ethereum synchronously before its bootstrap returns, in both compatibility modes', async () => {
	const artifacts = await generateArtifactsFromSources()
	for (const metamaskCompatibilityMode of [false, true]) {
		const documentStart = getArtifact(artifacts, getManifestV2DocumentStartScriptPath(metamaskCompatibilityMode))
		const { pageWindow, insertedScripts, contentScriptGlobal, errors } = runDocumentStart(documentStart.source, { pageCspBlocksInlineScripts: false })

		assert.equal(isInterceptorProvider(Reflect.get(pageWindow, 'ethereum')), true, 'window.ethereum was not defined when document-start returned')
		assert.deepEqual(insertedScripts, [{ external: false, ranSynchronously: true, src: '' }])
		assert.equal(contentScriptGlobal.interceptorInjected, true)
		assert.deepEqual(errors, [])
		assert.equal(documentStart.source.includes(`const metamaskCompatibilityModeAtPageLoad = ${ metamaskCompatibilityMode }`), true)
		assert.equal(documentStart.source.includes(`const metamaskCompatibilityModeAtPageLoad = ${ !metamaskCompatibilityMode }`), false)
	}
})

test('MV2 document-start loads the provider from its extension URL when the page CSP blocks the inline provider', async () => {
	const artifacts = await generateArtifactsFromSources()
	for (const metamaskCompatibilityMode of [false, true]) {
		const documentStart = getArtifact(artifacts, getManifestV2DocumentStartScriptPath(metamaskCompatibilityMode))
		const { insertedScripts, contentScriptGlobal } = runDocumentStart(documentStart.source, { pageCspBlocksInlineScripts: true })

		assert.deepEqual(insertedScripts, [
			{ external: false, ranSynchronously: false, src: '' },
			{ external: true, ranSynchronously: false, src: `moz-extension://interceptor/${ getPageWorldScriptPaths(metamaskCompatibilityMode)[0] }` },
		])
		assert.equal(contentScriptGlobal.interceptorInjected, true)
	}
})

test('MV2 generated document-start scripts keep no build markers', async () => {
	for (const artifact of await generateArtifactsFromSources()) {
		for (const marker of [pageWorldProviderSourceMarker, pageWorldProviderScriptPathMarker, metamaskCompatibilityModeAtPageLoadMarker]) assert.equal(artifact.source.includes(marker), false, `${ artifact.path } still contains ${ marker }`)
	}
})

test('MV3 page-world provider artifacts are the compatibility-mode providers, unchanged by MV2 inlining', async () => {
	const compiledInpage = await compileClassicScript('../../app/inpage/ts/inpage.ts')
	const artifacts = await generateArtifactsFromSources()
	for (const metamaskCompatibilityMode of [false, true]) {
		const providerPath = getPageWorldScriptPaths(metamaskCompatibilityMode)[0]
		if (providerPath === undefined) throw new Error('Missing page-world provider path')
		assert.equal(getArtifact(artifacts, providerPath).source, inlineMetamaskCompatibilityModeAtPageLoad(compiledInpage, metamaskCompatibilityMode))
	}
	assert.equal(artifacts.length, 4)
})

test('inlining keeps $ replacement sequences in the provider source literal', async () => {
	const providerSource = 'window.replacementSequences = "$& $1 $$ $\' $`"'
	const inlined = inlineDocumentStartPageWorldProvider(await compileClassicScript('../../app/inpage/ts/document_start.ts'), { source: providerSource, scriptPath: 'inpage/js/inpage.js' })
	assert.equal(inlined.includes(JSON.stringify(providerSource)), true)
})

test('MV2 leaves injection retryable when bootstrap prerequisites are missing', async () => {
	const generatedDocumentStart = getArtifact(await generateArtifactsFromSources(), getManifestV2DocumentStartScriptPath(false)).source
	const fakeGlobalThis: { interceptorInjected?: boolean } = {}
	const errors: unknown[] = []

	new Function('globalThis', 'browser', 'document', 'console', generatedDocumentStart)(fakeGlobalThis, { runtime: { lastError: undefined, getURL: (path: string) => path } }, {}, { error: (...args: unknown[]) => errors.push(args) })

	assert.equal(fakeGlobalThis.interceptorInjected, undefined)
	assert.equal(errors.length, 1)
})
