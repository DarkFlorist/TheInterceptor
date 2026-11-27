import * as assert from 'node:assert'
import { test } from 'bun:test'
import { getExtensionTabReuse } from '../../app/ts/background/extensionTabPolicy.js'

test('ordinary extension pages preserve their current route unless a target is supplied', () => {
	for (const tabName of ['settingsView', 'addressBook', 'websiteAccess'] as const) {
		const targetUrl = `/html3/${ tabName }V3.html`
		const resolvedTargetUrl = new URL(targetUrl, 'chrome-extension://extension/')
		const context = { targetUrl, resolvedTargetUrl, currentTabUrl: `${ resolvedTargetUrl.href }#existing`, targetSuffix: '' }
		assert.deepEqual(getExtensionTabReuse(tabName, context), { action: 'reuse' })
		assert.deepEqual(getExtensionTabReuse(tabName, { ...context, targetUrl: `${ targetUrl }#target`, targetSuffix: '#target' }), { action: 'reuse', url: `${ targetUrl }#target` })
	}
})

test('untargeted simulation stack reuse clears stale routes but avoids reloading an unaddressed page', () => {
	const targetUrl = '/html3/simulationStackV3.html'
	const resolvedTargetUrl = new URL(targetUrl, 'chrome-extension://extension/')
	const context = { targetUrl, resolvedTargetUrl, targetSuffix: '' }
	for (const currentTabUrl of [undefined, resolvedTargetUrl.href]) {
		assert.deepEqual(getExtensionTabReuse('simulationStack', { ...context, currentTabUrl }), { action: 'reuse' })
	}
	for (const currentTabUrl of [`${ resolvedTargetUrl.href }#stale`, '/html3/oldPage.html', 'http://[invalid']) {
		assert.deepEqual(getExtensionTabReuse('simulationStack', { ...context, currentTabUrl }), { action: 'reuse', url: targetUrl })
	}
})

test('native host page identity is separate from reusable tabs and stored tab ids', async () => {
	const { PartialIdsOfOpenedTabs } = await import('../../app/ts/utils/storageUtils.js')
	const { getHtmlFile } = await import('../../app/ts/utils/htmlPages.js')
	const hostIsReusable: 'gnosisSafeAppsHost' extends Parameters<typeof import('../../app/ts/background/extensionTabs.js').openExtensionTab>[0] ? true : false = false
	assert.equal(hostIsReusable, false)
	assert.equal('gnosisSafeAppsHost' in PartialIdsOfOpenedTabs.fields, false)
	assert.equal(getHtmlFile('gnosisSafeAppsHost', 3), '/html3/gnosisSafeAppsHostV3.html')
})
