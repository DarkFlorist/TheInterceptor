import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { pageDefinitions, renderExtensionPage, stylesheetFilenames } from '../../scripts/generate-extension-pages.mts'

function getPageDefinition(name: string) {
	const definition = pageDefinitions.find((pageDefinition) => pageDefinition.name === name)
	if (definition === undefined) throw new Error(`Missing page definition: ${ name }`)
	return definition
}

test('checked-in extension pages match their shared generator', async () => {
	const childProcess = Bun.spawn({
		cmd: [process.execPath, './scripts/generate-extension-pages.mts', '--check'],
		stdout: 'pipe',
		stderr: 'pipe',
	})
	const [exitCode, stderr] = await Promise.all([
		childProcess.exited,
		new Response(childProcess.stderr).text(),
	])
	assert.equal(exitCode, 0, stderr)
})

describe('extension page rendering', () => {
	test('renders the configured title, root, entry point, and optional styles', () => {
		const popup = renderExtensionPage(getPageDefinition('popup'), 3)
		assert.match(popup, /<title>The Interceptor<\/title>/)
		assert.match(popup, /<main>Loading\.\.\.<\/main>/)
		assert.doesNotMatch(popup, /bulma-(?:badge|divider)\.css/)
		assert.doesNotMatch(popup, /(?:bulma|interceptor)\.css/)
		assert.deepEqual(
			[...popup.matchAll(/href = '\.\.\/css\/([^']+\.css)'/g)].map((match) => match[1]),
			stylesheetFilenames,
		)
		assert.match(popup, /src = '\.\.\/js\/popup\.js'/)

		const addressBook = renderExtensionPage(getPageDefinition('addressBook'), 3)
		assert.match(addressBook, /src = '\.\.\/js\/addressBookRender\.js'/)
		assert.doesNotMatch(addressBook, /bulma-(?:badge|divider)\.css/)

		const simulationStack = renderExtensionPage(getPageDefinition('simulationStack'), 3)
		assert.match(simulationStack, /<div id = 'simulation-stack-root'>Loading\.\.\.<\/div>/)

		const watchAsset = renderExtensionPage(getPageDefinition('watchAsset'), 3)
		assert.match(watchAsset, /<title>Watch Asset - The Interceptor<\/title>/)
		assert.match(watchAsset, /src = '\.\.\/js\/watchAsset\.js'/)
		assert.doesNotMatch(watchAsset, /bulma-(?:badge|divider)\.css/)
	})

	test('preserves the intentional manifest-specific differences', () => {
		const websiteAccessV2 = renderExtensionPage(getPageDefinition('websiteAccess'), 2)
		const websiteAccessV3 = renderExtensionPage(getPageDefinition('websiteAccess'), 3)
		assert.match(websiteAccessV2, /overflow-y: inherit/)
		assert.match(websiteAccessV3, /overflow-y: scroll/)

		const confirmTransactionV3 = renderExtensionPage(getPageDefinition('confirmTransaction'), 3)
		assert.ok(confirmTransactionV3.indexOf('browser-polyfill.js') < confirmTransactionV3.indexOf('<main>Loading...</main>'))

		const changeChainV3 = renderExtensionPage(getPageDefinition('changeChain'), 3)
		assert.ok(changeChainV3.indexOf('browser-polyfill.js') > changeChainV3.indexOf('<main>Loading...</main>'))
	})

	test('defines each generated page exactly once', () => {
		assert.equal(new Set(pageDefinitions.map((definition) => definition.name)).size, pageDefinitions.length)
	})
})
