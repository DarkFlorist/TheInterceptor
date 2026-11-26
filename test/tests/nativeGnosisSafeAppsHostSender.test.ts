import * as assert from 'node:assert/strict'
import { test } from 'bun:test'
import { getAuthorizedNativeGnosisSafeAppsHostSenderUrl } from '../../app/ts/background/nativeGnosisSafeAppsHostSender.js'

for (const hostUrl of ['chrome-extension://extension-id/html3/gnosisSafeAppsHostV3.html', 'moz-extension://extension-uuid/html/gnosisSafeAppsHost.html']) test(`both native-host transports share exact sender authorization for ${ hostUrl }`, () => {
	for (const suffix of ['', '?sourceTabId=12', '?sourceTabId=12#session', '#session']) {
		const url = `${ hostUrl }${ suffix }`
		assert.equal(getAuthorizedNativeGnosisSafeAppsHostSenderUrl({ id: 'extension-id', url }, 'extension-id', [hostUrl]), url)
	}
	for (const sender of [undefined, {}, { id: 'other-extension', url: hostUrl }, { id: 'extension-id' }, { id: 'extension-id', url: `${ hostUrl }/lookalike` }, { id: 'extension-id', url: hostUrl.replace('gnosisSafeAppsHost', 'settingsView') }, { id: 'extension-id', url: `https://app.example/?host=${ hostUrl }` }]) {
		assert.equal(getAuthorizedNativeGnosisSafeAppsHostSenderUrl(sender, 'extension-id', [hostUrl]), undefined)
	}
})
