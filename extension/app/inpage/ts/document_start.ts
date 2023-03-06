function listenInContentScript() {
	/**
	 * this script executed within the context of the active tab when the user clicks the extension bar button
	 * this script serves as a _very thin_ proxy between the page scripts (dapp) and the extension, simply forwarding messages between the two
	*/
	// the content script is a very thin proxy between the background script and the page script
	const extensionPort = browser.runtime.connect()
	let connected = true

	// forward all message events to the background script, which will then filter and process them
	globalThis.addEventListener('message', messageEvent => {
		try {
			// we only want the data element, if it exists, and postMessage will fail if it can't clone the object fully (and it cannot clone a MessageEvent)
			if (!('data' in messageEvent)) return
			if (connected) extensionPort.postMessage({ data: messageEvent.data })
		} catch (error) {
			// CONSIDER: should we catch data clone error and then do `extensionPort.postMessage({data:JSON.parse(JSON.stringify(messageEvent.data))})`?
			if (error instanceof Error) {
				if (error.message?.includes('Extension context invalidated.')) {
					// this error happens when the extension is refreshed and the page cannot reach The Interceptor anymore
					return
				}
			}
			throw error
		}
	})

	// forward all messages we get from the background script to the window so the page script can filter and process them
	extensionPort.onMessage.addListener(response => {
		try {
			if (connected) globalThis.postMessage(response, '*')
		} catch (error) {
			console.error(error)
		}
	})

	extensionPort.onDisconnect.addListener(() => {
		connected = false
	})
}

function injectScript(content: any) {
	try {
		const container = document.head || document.documentElement
		const scriptTag = document.createElement('script')
		scriptTag.setAttribute('async', 'false')
		scriptTag.textContent = content
		container.insertBefore(scriptTag, container.children[0])
		container.removeChild(scriptTag)
		listenInContentScript()
	} catch (error) {
	  	console.error('Interceptor: Provider injection failed.', error)
	}
}

injectScript(`[[injected.ts]]`)
