import { createSafeAppsErrorResponse, createSafeAppsCancellation, isSafeAppsRequest, isSafeAppsResponse, type SafeAppsRequest } from './safeAppsProtocol.js'
import { createSafeAppsRequestQueue } from './safeAppsRequestQueue.js'
import { createSafeAppsTransport } from './safeAppsTransport.js'

// Adapts parent-based Safe SDK messaging to the authorized same-window bridge. Only register the bootstrap on explicitly selected HTTP(S) origins, before the app runs.
export function installSafeAppsHost() {
	const windowObject = window
	// Leave existing parent emulation intact if this bootstrap is loaded again.
	if (windowObject.top !== windowObject || windowObject.parent !== windowObject) return undefined
	const container = document.documentElement
	if (container === null) return undefined
	const originalParent = Object.getOwnPropertyDescriptor(windowObject, 'parent')
	const frame = document.createElement('iframe')
	frame.style.display = 'none'
	frame.setAttribute('aria-hidden', 'true')
	frame.tabIndex = -1
	container.append(frame)
	const apparentParent = frame.contentWindow
	if (apparentParent === null) {
		frame.remove()
		return undefined
	}
	// Fail atomically if the page made its parent property non-configurable.
	try { Object.defineProperty(windowObject, 'parent', { configurable: true, value: apparentParent }) } catch (error: unknown) {
		frame.remove()
		throw error
	}
	const transport = createSafeAppsTransport(windowObject)
	let disposed = false
	const deliver = (data: unknown) => windowObject.dispatchEvent(new MessageEvent('message', { data, origin: windowObject.location.origin, source: apparentParent }))
	const pendingRequests = createSafeAppsRequestQueue<SafeAppsRequest>({
		replaceOldestSafeInfo: true,
		timers: { setTimeout: windowObject.setTimeout.bind(windowObject), clearTimeout: windowObject.clearTimeout.bind(windowObject) },
		onRejected: (request, error, reason) => {
			if (reason === 'expired' || reason === 'superseded') transport.post(createSafeAppsCancellation(request.id))
			const reject = () => { if (!disposed) deliver(createSafeAppsErrorResponse(request, error)) }
			// Let the SDK install its response listener after posting a request.
			if (reason === 'expired') reject()
			else queueMicrotask(reject)
		},
	})
	// Listen on the real frame: native postMessage supplies the actual caller's source and origin.
	const onRequest = (event: MessageEvent<unknown>) => {
		if (disposed || event.source !== windowObject || event.origin !== windowObject.location.origin) return
		const message = event.data
		if (!isSafeAppsRequest(message)) return
		if (!pendingRequests.add(message)) return
		transport.post(message)
	}
	apparentParent.addEventListener('message', onRequest)
	const unsubscribe = transport.subscribe(({ data }) => {
		if (disposed || !isSafeAppsResponse(data)) return
		if (pendingRequests.take(data.id) === undefined) return
		deliver(data)
	})
	return {
		// Call before replacing the host or opting out in the current document; installing again restores hosting.
		dispose() {
			if (disposed) return
			disposed = true
			apparentParent.removeEventListener('message', onRequest)
			unsubscribe()
			const requests = pendingRequests.drain()
			for (const request of requests) {
				transport.post(createSafeAppsCancellation(request.id))
				deliver(createSafeAppsErrorResponse(request, 'Safe Apps hosting was disconnected.'))
			}
			// The SDK checks response.source against the current parent, so reject before restoring it; preserve any later page-owned replacement.
			if (windowObject.parent === apparentParent) {
				if (originalParent === undefined) Reflect.deleteProperty(windowObject, 'parent')
				else Object.defineProperty(windowObject, 'parent', originalParent)
			}
			frame.remove()
		},
	}
}
