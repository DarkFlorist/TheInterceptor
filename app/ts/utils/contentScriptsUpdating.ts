import { getInterceptorDisabledSites, getSettings } from "../background/settings.js"

export const updateContentScriptInjectionStrategyManifestV3 = async () => {
	const excludeMatches = getInterceptorDisabledSites(await getSettings()).map((origin) => `*://*.${ origin }/*`)
	try {
		type RegisteredContentScript = Parameters<typeof browser.scripting.registerContentScripts>[0][0]
		// 'MAIN'` is not supported in `browser.` but its in `chrome.`. This code is only going to be run in manifest v3 environment (chrome) so this should be fine, just ugly
		type FixedRegisterContentScripts = (scripts: (RegisteredContentScript & { world?: 'MAIN' | 'ISOLATED' })[]) => Promise<void>
		const fixedRegisterContentScripts = ((browser.scripting.registerContentScripts as unknown) as FixedRegisterContentScripts)
		await browser.scripting.unregisterContentScripts()
		await fixedRegisterContentScripts([{
			id: 'inpage2',
			matches: ['file://*/*', 'http://*/*', 'https://*/*'],
			excludeMatches,
			js: ['/vendor/webextension-polyfill/browser-polyfill.js', '/inpage/js/listenContentScript.js'],
			runAt: 'document_start',
		}, {
			id: 'inpage',
			matches: ['file://*/*', 'http://*/*', 'https://*/*'],
			excludeMatches,
			js: ['/inpage/js/inpage.js'],
			runAt: 'document_start',
			world: 'MAIN',
		}])
	} catch (err) {
		console.warn(err)
	}
}

let registeredScript: browser.contentScripts.RegisteredContentScript | undefined = undefined 
export const updateContentScriptInjectionStrategyManifestV2 = async () => {
	const excludeMatches = getInterceptorDisabledSites(await getSettings()).map((origin) => `*://*.${ origin }/*`)
	try {
		if (registeredScript) await registeredScript.unregister()
		registeredScript = await browser.contentScripts.register({
			matches: ['file://*/*', 'http://*/*', 'https://*/*'],
			excludeMatches,
			js: [
				{ file: '/vendor/webextension-polyfill/browser-polyfill.js' },
				{ file: '/inpage/output/injected_document_start.js' }
			],
			allFrames: true,
			runAt: 'document_start'
		})
	} catch (err) {
		throw new Error('Unable to register content script. Unfortunately, we are not supporting Chrome with Manifest V2. Please run the Chrome version that has manifest v3')
	}
}
