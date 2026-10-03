import { createSafeAppsErrorResponse, createSafeAppsCancellation, parseSafeAppsRequest, isSafeAppsResponse, type SafeAppsRequest } from './safeAppsProtocol.js'
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
	const deliver = (data: unknown) => {
		// The token belongs to the bridge; SDK callbacks receive their ordinary response shape.
		const sdkData = typeof data === 'object' && data !== null && 'bridgeToken' in data ? { ...data } : data
		if (typeof sdkData === 'object' && sdkData !== null) Reflect.deleteProperty(sdkData, 'bridgeToken')
		windowObject.dispatchEvent(new MessageEvent('message', { data: sdkData, origin: windowObject.location.origin, source: apparentParent }))
	}
	const pendingRequests = createSafeAppsRequestQueue<SafeAppsRequest>({
		replaceOldestSafeInfo: true,
		timers: { setTimeout: windowObject.setTimeout.bind(windowObject), clearTimeout: windowObject.clearTimeout.bind(windowObject) },
		onRejected: (request, error, reason) => {
			if (reason === 'expired' || reason === 'superseded') transport.post(createSafeAppsCancellation(request.id, request.bridgeToken))
			const reject = () => { if (!disposed) deliver(createSafeAppsErrorResponse(request, error)) }
			// Let the SDK install its response listener after posting a request.
			if (reason === 'expired') reject()
			else queueMicrotask(reject)
		},
	})
	// Listen on the real frame: native postMessage supplies the actual caller's source and origin.
	const onRequest = (event: MessageEvent<unknown>) => {
		if (disposed || event.source !== windowObject || event.origin !== windowObject.location.origin) return
		const parsed = parseSafeAppsRequest(event.data)
		if (parsed === undefined) return
		if ('error' in parsed) {
			// The caller installs its response listener after posting the request.
			queueMicrotask(() => { if (!disposed) deliver(createSafeAppsErrorResponse(parsed, parsed.error)) })
			return
		}
		// Distinguish reused IDs with a token that works on HTTP origins too.
		const bridgeToken = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('')
		const request = { ...parsed.request, bridgeToken }
		if (!pendingRequests.add(request)) return
		transport.post(request)
	}
	apparentParent.addEventListener('message', onRequest)
	const unsubscribe = transport.subscribe(({ data }) => {
		if (disposed || !isSafeAppsResponse(data)) return
		const pending = pendingRequests.values().find((request) => request.id === data.id)
		if (pending === undefined || data.bridgeToken !== undefined && data.bridgeToken !== pending.bridgeToken) return
		pendingRequests.take(data.id)
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
				transport.post(createSafeAppsCancellation(request.id, request.bridgeToken))
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
