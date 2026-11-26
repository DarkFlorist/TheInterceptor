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

test('a native host only reuses the exact launch, preserving live drafts on different launches', () => {
	for (const root of ['chrome-extension://extension/', 'moz-extension://extension/']) {
		const targetSuffix = '?sourceTabId=23&appUrl=https%3A%2F%2Fapp.example%2F'
		const targetUrl = `/html/gnosisSafeAppsHost.html${ targetSuffix }`
		const resolvedTargetUrl = new URL(targetUrl, root)
		const context = { targetUrl, resolvedTargetUrl, targetSuffix }
		assert.deepEqual(getExtensionTabReuse('gnosisSafeAppsHost', { ...context, currentTabUrl: resolvedTargetUrl.href }), { action: 'reuse' })
		for (const currentTabUrl of [undefined, resolvedTargetUrl.href.replace('sourceTabId=23', 'sourceTabId=24'), resolvedTargetUrl.href.replace('app.example', 'another.example')]) {
			assert.deepEqual(getExtensionTabReuse('gnosisSafeAppsHost', { ...context, currentTabUrl }), { action: 'open' })
		}
	}
})
