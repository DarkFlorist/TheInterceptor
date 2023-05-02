import './background/background.js'
import { getHtmlFile } from './background/backgroundUtils.js'
import { clearTabStates } from './background/settings.js'
import { sleep } from './utils/node.js'

browser.action.setPopup({ popup: getHtmlFile('popup') })

self.addEventListener('install', () => {
	console.log('The Interceptor installed')
})

self.addEventListener('activate', () => clearTabStates())

// 'MAIN'` is not supported in `browser.` but its in `chrome.`. This code is only going to be run in manifest v3 environment (chrome) so this should be fine, just ugly
type RegisteredContentScript = Parameters<typeof browser.scripting.registerContentScripts>[0][0]
type FixedRegisterContentScripts = (scripts: (RegisteredContentScript & { world?: 'MAIN' | 'ISOLATED' })[]) => Promise<void>
const fixedRegisterContentScripts = ((browser.scripting.registerContentScripts as unknown) as FixedRegisterContentScripts)

const injectContentScript = async () => {
	try {
		await fixedRegisterContentScripts([{
			id: 'inpage2',
			matches: ['file://*/*', 'http://*/*', 'https://*/*'],
			js: ['/vendor/webextension-polyfill/browser-polyfill.js', '/inpage/js/listenContentScript.js'],
			runAt: 'document_start',
		}, {
			id: 'inpage',
			matches: ['file://*/*', 'http://*/*', 'https://*/*'],
			js: ['/inpage/js/inpage.js'],
			runAt: 'document_start',
			world: 'MAIN',
		}])
	} catch (err) {
		console.warn(err)
	}
}

injectContentScript()

/// Workaround for ChromiumIssue1316588 https://bugs.chromium.org/p/chromium/issues/detail?id=1316588
// TODO, remove when chrome fixes the bug
const storageArea = browser.storage.local as browser.storage.StorageArea & { onChanged: browser.storage.StorageChange }

const TEST_INTERVAL_MS = 10000
const STORAGE_WAIT_TIME_MS = 2000

const hasChromiumIssue1316588 = async () => {
	let dispatched = false
	const testEventDispatching = () => {
		storageArea.onChanged.removeListener(testEventDispatching)
		dispatched = true
	}
	storageArea.onChanged.addListener(testEventDispatching)
	storageArea.set({ testEventDispatching: Math.random() })
	await sleep(STORAGE_WAIT_TIME_MS)
	return !dispatched
}

const fixChromiumIssue1316588 = async () => {
	try {
		const hasIssue = await hasChromiumIssue1316588()
		if (!hasIssue) return
		console.warn('Reloading because of Chromium Issue 1316588')
		browser.runtime.reload()
		clearInterval(intervalId)
	} catch (error) {
		console.error(error)
	}
}
const intervalId = setInterval(fixChromiumIssue1316588, TEST_INTERVAL_MS)

fixChromiumIssue1316588()
// End of workaround for ChromiumIssue1316588
