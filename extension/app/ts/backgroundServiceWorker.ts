import './background/background.js'
import { getHtmlFile } from './background/backgroundUtils.js'

browser.action.setPopup({ popup: getHtmlFile('popup') })

self.addEventListener('install', () => {
	console.log('install')
})

const injectContentScript = async () => {
	try {
		await browser.scripting.registerContentScripts([{
			id: 'inpage2',
			matches: ['file://*/*', 'http://*/*', 'https://*/*'],
			js: ['/vendor/webextension-polyfill/browser-polyfill.js', '/inpage/js/listenContentScript.js'],
			runAt: 'document_start',
		} ])
		await chrome.scripting.registerContentScripts([{ // we need to use `chrome` here instead of `browser` as `world: 'MAIN'` is not supported otherwise
			id: 'inpage',
			matches: ['file://*/*', 'http://*/*', 'https://*/*'],
			js: ['/inpage/js/inpage.js'],
			runAt: 'document_start',
			world: 'MAIN',
		} ])
	} catch (err) {
		console.warn(err)
	}
}

injectContentScript()
