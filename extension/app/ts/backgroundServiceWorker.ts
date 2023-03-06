import './background/background.js'
/*
chrome.runtime.onStartup.addListener(() => {
	console.log('onStartup()')
})

chrome.runtime.onMessage.addListener((message: unknown) => {
	console.log('OnMessage')
	console.log(message)
	return false
})

chrome.runtime.onMessageExternal.addListener(({ type, name }) => {
	console.log('onMessageExternal')
	console.log(type)
	console.log(name)
	return false
})
*/
chrome.action.setPopup({ popup: 'html3/popupV3.html' })

self.addEventListener('install', () => {
	console.log('install')
})

/*
async function onContentScriptConnected(port: chrome.runtime.Port) {
	console.log('content script connected')
	port.onMessage.addListener(async (payload) => {
		if(!(
			'data' in payload
			&& typeof payload.data === 'object'
			&& payload.data !== null
			&& 'interceptorRequest' in payload.data
		)) return
		console.log(payload)
		const request = InterceptedRequest.parse(payload.data)
		console.log(request.options.method)
	})
}
chrome.runtime.onConnect.addListener(port => onContentScriptConnected(port).catch(console.error))
*/

const injectContentScript = async () => {
	try {
		await chrome.scripting.registerContentScripts([{
			id: 'inpage2',
			matches: ['file://*/*', 'http://*/*', 'https://*/*'],
			js: ['/vendor/webextension-polyfill/browser-polyfill.js', './js/listenContentScript.js'],
			runAt: 'document_start',
		} ])
		await chrome.scripting.registerContentScripts([{
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
