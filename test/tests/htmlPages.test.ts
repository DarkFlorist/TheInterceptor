import * as assert from 'node:assert/strict'
import { test } from 'bun:test'
import { getHtmlFile, getHtmlPageUrl } from '../../app/ts/utils/htmlPages.js'

for (const manifestVersion of [2, 3]) test(`extension page paths use the manifest ${ manifestVersion } variant for launch and authorization`, () => {
	const folder = manifestVersion === 2 ? 'html' : 'html3'
	const suffix = manifestVersion === 2 ? '' : 'V3'
	assert.equal(getHtmlFile('popup', manifestVersion), `/${ folder }/popup${ suffix }.html`)
	assert.equal(getHtmlFile('gnosisSafeAppsHost', manifestVersion), `/${ folder }/gnosisSafeAppsHost${ suffix }.html`)
	for (const root of ['moz-extension://extension-id/', 'chrome-extension://extension-id/']) {
		assert.equal(getHtmlPageUrl('gnosisSafeAppsHost', root, manifestVersion), `${ root }${ folder }/gnosisSafeAppsHost${ suffix }.html`)
		assert.equal(new URL(getHtmlPageUrl('gnosisSafeAppsHost', root, manifestVersion)).pathname.startsWith('//'), false)
	}
})
