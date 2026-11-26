import { createGnosisSafeAppsBridgeMessage, parseGnosisSafeAppsBridgeMessage, createGnosisSafeAppsCancellation, createNativeGnosisSafeAppsSourceDisconnected, type NativeGnosisSafeAppsSourceReply } from '../../shared/ts/gnosisSafeAppsBridgeProtocol.js'
import { GNOSIS_SAFE_APPS_SOURCE_DISCOVERY_TIMEOUT_MS, isGnosisSafeAppsDiscoveryMethod, parseGnosisSafeAppsRequest, parseGnosisSafeAppsResponse } from '../../shared/ts/gnosisSafeAppsProtocol.js'
import { createGnosisSafeAppsRequestQueue } from '../../shared/ts/gnosisSafeAppsRequestQueue.js'
import { createGnosisSafeAppsTransport, type GnosisSafeAppsWindow } from '../../shared/ts/gnosisSafeAppsTransport.js'

type SourceRequest = {
	readonly id: string
	readonly method: string
	readonly originalId: string
	readonly bridgeToken: string
	readonly resolve: (response: NativeGnosisSafeAppsSourceReply) => void
	readonly reject: (error: unknown) => void
}

// The source page is a private round-trip client of its existing provider. Protocol parsing, capacity, expiry and source/origin filtering remain owned by the shared SDK modules.
export function createNativeGnosisSafeAppsSourceBridge(windowObject: GnosisSafeAppsWindow, randomToken: () => string, timers: { readonly setTimeout: (callback: () => void, delay: number) => number, readonly clearTimeout: (id: number) => void }) {
	const transport = createGnosisSafeAppsTransport(windowObject)
	let unsubscribe: (() => void) | undefined
	const stopIfIdle = () => {
		if (pending.values().length !== 0) return
		unsubscribe?.()
		unsubscribe = undefined
	}
	const pending = createGnosisSafeAppsRequestQueue<SourceRequest>({
		timeoutMs: GNOSIS_SAFE_APPS_SOURCE_DISCOVERY_TIMEOUT_MS,
		timers,
		expires: (request) => isGnosisSafeAppsDiscoveryMethod(request.method),
		onRejected: (request, error, reason) => {
			if (reason === 'expired') transport.post(createGnosisSafeAppsBridgeMessage(createGnosisSafeAppsCancellation(request.id), request.bridgeToken))
			request.reject(new Error(error))
			stopIfIdle()
		},
	})
	const subscribe = () => {
		if (unsubscribe !== undefined) return
		unsubscribe = transport.subscribe(({ data }) => {
			const message = parseGnosisSafeAppsBridgeMessage(data)
			if (message === undefined) return
			const response = parseGnosisSafeAppsResponse(message.envelope)
			if (response === undefined) return
			const request = pending.values().find(({ id }) => id === response.id)
			if (request === undefined || message.bridgeToken !== request.bridgeToken) return
			pending.take(request.id)
			stopIfIdle()
			request.resolve({ ...response, id: request.originalId })
		})
	}
	return {
		request(value: unknown): Promise<NativeGnosisSafeAppsSourceReply> {
			const parsed = parseGnosisSafeAppsRequest(value)
			if (parsed === undefined || !('request' in parsed)) return Promise.reject(new Error('Invalid native Gnosis Safe Apps SDK envelope.'))
			const sdkRequest = parsed.request
			const id = randomToken()
			const bridgeToken = randomToken()
			return new Promise((resolve, reject) => {
				if (!pending.add({ id, method: sdkRequest.method, originalId: sdkRequest.id, bridgeToken, resolve, reject })) return
				subscribe()
				try { transport.post(createGnosisSafeAppsBridgeMessage({ ...sdkRequest, id }, bridgeToken)) } catch (error: unknown) {
					pending.take(id)
					stopIfIdle()
					reject(error)
				}
			})
		},
		cancelPending() {
			for (const request of pending.drain()) request.resolve(createNativeGnosisSafeAppsSourceDisconnected(request.originalId))
			stopIfIdle()
		},
	}
}
