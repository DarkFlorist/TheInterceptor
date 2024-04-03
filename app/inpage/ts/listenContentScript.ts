function listenContentScript(conectionName: string | undefined) {
	/**
	 * this script executed within the context of the active tab when the user clicks the extension bar button
	 * this script serves as a _very thin_ proxy between the page scripts (dapp) and the extension, simply forwarding messages between the two
	*/
	// the content script is a very thin proxy between the background script and the page script

	const dec2hex = (dec: number) => dec.toString(16).padStart(2, '0')

	function generateId (len: number) {
		const arr = new Uint8Array((len || 40) / 2)
		globalThis.crypto.getRandomValues(arr)
		return `0x${ Array.from(arr, dec2hex).join('') }`
	}
	const connectionNameNotUndefined = conectionName === undefined ? generateId(40) : conectionName
	const extensionPort = browser.runtime.connect({ name: connectionNameNotUndefined })

	// forward all message events to the background script, which will then filter and process them
	// biome-ignore lint/suspicious/noExplicitAny: MessageEvent default signature
	const listener = (messageEvent: MessageEvent<any>) => {
		try {
			// we only want the data element, if it exists, and postMessage will fail if it can't clone the object fully (and it cannot clone a MessageEvent)
			if (!('data' in messageEvent)) return
			extensionPort.postMessage({ data: messageEvent.data })
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
	}
	globalThis.addEventListener('message', listener)

	// forward all messages we get from the background script to the window so the page script can filter and process them
	extensionPort.onMessage.addListener(response => {
		try {
			globalThis.postMessage(response, '*')
		} catch (error) {
			console.error(error)
		}
	})

	extensionPort.onDisconnect.addListener(() => {
		globalThis.removeEventListener('message', listener)
		listenContentScript(connectionNameNotUndefined)
	})
}
listenContentScript(undefined)
