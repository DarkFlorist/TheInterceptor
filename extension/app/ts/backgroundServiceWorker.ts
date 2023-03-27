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

/// Workaround for ChromiumIssue1316588 https://bugs.chromium.org/p/chromium/issues/detail?id=1316588
// TODO, remove when chrome fixes the bug
const storageArea = browser.storage.local as browser.storage.LocalStorageArea & { onChanged: browser.storage.StorageChangedEvent }

const TEST_INTERVAL_MS = 10000
const STORAGE_WAIT_TIME_MS = 100

const hasChromiumIssue1316588 = () => {
	return new Promise((resolve) => {
		let dispatched = false
		const testEventDispatching = () => {
			storageArea.onChanged.removeListener(testEventDispatching)
			dispatched = true
		}
		storageArea.onChanged.addListener(testEventDispatching)
		storageArea.set({ testEventDispatching: Math.random() })
		setTimeout(() => resolve(!dispatched), STORAGE_WAIT_TIME_MS)
	})
}

const fixChromiumIssue1316588 = () => {
	hasChromiumIssue1316588().then((hasIssue) => {
		if (hasIssue) {
			browser.runtime.reload()
		} else {
			setTimeout(fixChromiumIssue1316588, TEST_INTERVAL_MS)
		}
	})
}

fixChromiumIssue1316588()
// End of workaround for ChromiumIssue1316588
