import * as assert from 'assert'
import { test } from 'bun:test'
import * as ts from 'typescript'
import { getPageWorldScriptPaths } from '../../app/ts/utils/contentScriptInjectionArtifacts.js'
import { contentScriptDocumentMarkers } from '../../app/ts/utils/contentScriptDocumentMarkers.js'
import { metamaskCompatibilityModeAtPageLoadMarker } from '../../scripts/content-script-injection-markers.mts'
import { generatePageWorldProviders, inlineMetamaskCompatibilityModeAtPageLoad } from '../../scripts/generate-page-world-providers.mts'

const compileClassicScript = async (sourcePath: string) => ts.transpileModule(await Bun.file(new URL(sourcePath, import.meta.url)).text(), {
	compilerOptions: {
		module: ts.ModuleKind.ESNext,
		target: ts.ScriptTarget.ES2022,
	},
}).outputText

test('page-world compatibility mode is embedded as a build-time boolean', async () => {
	const compiledSource = await compileClassicScript('../../app/inpage/ts/inpage.ts')
	for (const metamaskCompatibilityMode of [false, true]) {
		const generatedPageWorldSource = inlineMetamaskCompatibilityModeAtPageLoad(compiledSource, metamaskCompatibilityMode)
		assert.equal(generatedPageWorldSource.includes(`const metamaskCompatibilityModeAtPageLoad = ${ metamaskCompatibilityMode }`), true)
		assert.equal(generatedPageWorldSource.includes(`const metamaskCompatibilityModeAtPageLoad = ${ !metamaskCompatibilityMode }`), false)
		assert.equal(generatedPageWorldSource.includes(metamaskCompatibilityModeAtPageLoadMarker), false)
		assert.equal(generatedPageWorldSource.includes('TheInterceptor.metamaskCompatibilityMode'), false)
	}
})

test('the generated artifacts are exactly the registered compatibility-mode providers', async () => {
	const compiledInpage = await compileClassicScript('../../app/inpage/ts/inpage.ts')
	const artifacts = generatePageWorldProviders(compiledInpage)
	assert.deepEqual(artifacts.map(({ path, metamaskCompatibilityMode }) => ({ path, metamaskCompatibilityMode })), [false, true].map((metamaskCompatibilityMode) => ({ path: getPageWorldScriptPaths(metamaskCompatibilityMode)[0], metamaskCompatibilityMode })))
	for (const artifact of artifacts) {
		assert.equal(artifact.source, inlineMetamaskCompatibilityModeAtPageLoad(compiledInpage, artifact.metamaskCompatibilityMode))
		assert.equal(artifact.source.includes(metamaskCompatibilityModeAtPageLoadMarker), false, `${ artifact.path } still contains the build marker`)
	}
})

test('both compatibility-mode providers check the same once-per-document markers first', async () => {
	const compiledInpage = await compileClassicScript('../../app/inpage/ts/inpage.ts')
	const { disabledOriginKey, claimedKey } = contentScriptDocumentMarkers.MAIN
	for (const artifact of generatePageWorldProviders(compiledInpage)) {
		const [firstStatement, secondStatement] = artifact.source.trimStart().split('\n').filter((line) => line.trim() !== '' && !line.trim().startsWith('//'))
		assert.equal(firstStatement?.includes(`Symbol.for('${ disabledOriginKey }')`), true, `${ artifact.path } does not check the disabled-origin marker first`)
		assert.equal(secondStatement?.includes(`Symbol.for('${ claimedKey }')`), true, `${ artifact.path } does not claim the document right after`)
	}
})

test('generation fails when inpage.js lost its compatibility-mode marker', () => {
	assert.throws(() => generatePageWorldProviders('const metamaskCompatibilityModeAtPageLoad = false'), /Could not find MetaMask compatibility mode at page load marker/)
})
