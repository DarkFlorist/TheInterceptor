// Per-test browser mock for popup hooks that listen on browser.runtime.onMessage.
//
// Usage (at the top level of a test file):
//   const installRuntimeMessaging = createRuntimeMessagingInstaller()
//   const messaging = installRuntimeMessaging()           // restored after the current test
//   messaging.dispatch(MessageToPopup.serialize(message))  // delivers a message to the registered listeners synchronously
//   assert.equal(messaging.listenerCount(), 1)
//   const { keptChannelOpen, response } = messaging.dispatchAndCaptureReply({ method: 'popup_isSimulationVisualizerOpen' })
import type { BrowserMockOptions } from '../harness/browserMock.js'
import { createPerTestBrowserMockInstaller } from '../harness/perTest.js'

export type RuntimeMessaging = ReturnType<ReturnType<typeof createRuntimeMessagingInstaller>>

// Call at the top level of a test file: the afterEach hook that restores the mock belongs to the file that registers it.
export function createRuntimeMessagingInstaller() {
	const installBrowserMock = createPerTestBrowserMockInstaller()
	return (options: BrowserMockOptions = {}) => {
		const browserMock = installBrowserMock(options)
		const onMessage = browserMock.browser.runtime.onMessage
		const registeredListeners = new Set<Parameters<typeof onMessage.addListener>[0]>()
		const addListener = onMessage.addListener
		const removeListener = onMessage.removeListener
		onMessage.addListener = (listener) => {
			registeredListeners.add(listener)
			addListener(listener)
		}
		onMessage.removeListener = (listener) => {
			registeredListeners.delete(listener)
			removeListener(listener)
		}
		return {
			browserMock,
			sentMessages: browserMock.calls.runtimeSendMessage,
			// The number of runtime.onMessage listeners that are registered right now.
			listenerCount: () => registeredListeners.size,
			// Delivers a message to the listeners synchronously, so a listener that throws would throw here.
			dispatch: (message: unknown) => { onMessage.dispatch(message, { id: browserMock.browser.runtime.id }, () => undefined) },
			// Delivers a message to each listener in registration order, awaiting each listener's returned promise before calling the next one.
			dispatchAndAwaitListeners: async (message: unknown) => {
				for (const listener of [...registeredListeners]) await listener(message, { id: browserMock.browser.runtime.id }, () => undefined)
			},
			// Delivers a message like dispatch and reports whether a listener kept the channel open (returned true) and what it passed to sendResponse synchronously.
			dispatchAndCaptureReply: (message: unknown) => {
				let response: unknown
				const listenerResults = onMessage.dispatch(message, { id: browserMock.browser.runtime.id }, (nextResponse) => { response = nextResponse })
				return { keptChannelOpen: listenerResults.includes(true), response }
			},
		}
	}
}
