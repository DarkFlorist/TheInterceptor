export type SafeAppsWindow = {
	readonly location: { readonly origin: string }
	addEventListener(type: 'message', listener: (event: Event) => void): void
	removeEventListener(type: 'message', listener: (event: Event) => void): void
	postMessage(message: unknown, targetOrigin: string): void
}

// The provider, parent host and preparation share this bidirectional channel. Keep both directions here when changing transport. Native source/origin checks exclude SDK replies synthesized by the host and requests sent directly by other frames.
export function createSafeAppsTransport(windowObject: SafeAppsWindow) {
	const postMessage = windowObject.postMessage.bind(windowObject)
	return {
		post(message: unknown, origin = windowObject.location.origin) { postMessage(message, origin) },
		subscribe(receive: (message: { readonly data: unknown, readonly origin: string }) => void) {
			const listener = (event: Event) => {
				if (!('data' in event) || !('origin' in event) || !('source' in event)) return
				if (event.source !== windowObject || event.origin !== windowObject.location.origin) return
				receive({ data: event.data, origin: event.origin })
			}
			windowObject.addEventListener('message', listener)
			return () => windowObject.removeEventListener('message', listener)
		},
	}
}
