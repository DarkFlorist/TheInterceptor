import { NATIVE_GNOSIS_SAFE_APPS_HOST_TIMING } from './nativeGnosisSafeAppsHostTiming.js'
import { NATIVE_GNOSIS_SAFE_APPS_SESSION_READY } from '../types/nativeGnosisSafeAppsHostContext.js'
import { createGnosisSafeAppsRequestHandler } from '../../shared/ts/gnosisSafeAppsClient.js'
import { GNOSIS_SAFE_APPS_RESPONSE_VERSION, type GnosisSafeAppsRequest, type GnosisSafeAppsResponse } from '../../shared/ts/gnosisSafeAppsProtocol.js'

type PendingReply = { readonly resolve: (value: unknown) => void, readonly reject: (error: Error) => void }

// The extension-owned host has its own request connection. The background derives its app origin from the authenticated launch URL, never from a request payload.
export function connectNativeGnosisSafeAppsHost() {
	const random = crypto.getRandomValues(new Uint32Array(2))
	const port = browser.runtime.connect({ name: `0x${ random[0]?.toString(16) }${ random[1]?.toString(16).padStart(8, '0') }` })
	const pending = new Map<number, PendingReply>()
	let nextRequestId = 0
	let stopped = false
	let failureMessage = 'Interceptor disconnected. Retry the connection to reconnect to the extension.'
	let startupTimeout: ReturnType<typeof setTimeout> | undefined
	const disconnectedError = () => new Error(failureMessage)
	let resolveSessionReady: (() => void) | undefined
	const sessionReady = new Promise<void>((resolve) => { resolveSessionReady = resolve })
	const ready = async () => { await sessionReady; if (stopped) throw disconnectedError() }
	let resolveFrameLoaded: (() => void) | undefined
	const frameLoaded = new Promise<void>((resolve) => { resolveFrameLoaded = resolve })
	const request = async (method: string, params?: unknown): Promise<unknown> => {
		if (stopped) throw disconnectedError()
		if (pending.size >= 40) throw new Error('Too many pending app requests. Finish the open approvals and try again.')
		const requestId = nextRequestId++
		return await new Promise((resolve, reject) => {
			pending.set(requestId, { resolve, reject })
			try { port.postMessage({ data: { method, params, requestId, interceptorRequest: true, ...(method === 'safe_apps_request' ? { interceptorInternalRequest: true } : {}), usingInterceptorWithoutSigner: false } }) } catch (error: unknown) {
				pending.delete(requestId)
				reject(error)
			}
		})
	}
	port.onMessage.addListener((message: unknown) => {
		if (!stopped && typeof message === 'object' && message !== null && 'type' in message && message.type === NATIVE_GNOSIS_SAFE_APPS_SESSION_READY) { clearTimeout(startupTimeout); resolveSessionReady?.(); return }
		if (typeof message !== 'object' || message === null || !('type' in message) || message.type !== 'result' || !('bridgeRequestSettled' in message) || message.bridgeRequestSettled !== true || !('requestId' in message) || typeof message.requestId !== 'number') return
		const reply = pending.get(message.requestId)
		if (reply === undefined) return
		pending.delete(message.requestId)
		if ('error' in message && typeof message.error === 'object' && message.error !== null && 'message' in message.error && typeof message.error.message === 'string') reply.reject(new Error(message.error.message))
		else reply.resolve('result' in message ? message.result : undefined)
	})
	const stop = () => {
		stopped = true
		clearTimeout(startupTimeout)
		resolveSessionReady?.()
		resolveFrameLoaded?.()
		for (const reply of pending.values()) reply.reject(disconnectedError())
		pending.clear()
	}
	port.onDisconnect.addListener(stop)
	startupTimeout = setTimeout(() => { failureMessage = 'Interceptor did not finish starting. Retry the connection.'; stop(); port.disconnect() }, NATIVE_GNOSIS_SAFE_APPS_HOST_TIMING.backgroundStartupTimeoutMs)
	const execute = createGnosisSafeAppsRequestHandler(async (value) => await request('safe_apps_request', [value]), async (value) => await request(value.method, value.params))
	let connected: Promise<unknown> | undefined
	return {
		ready,
		async request(envelope: GnosisSafeAppsRequest): Promise<GnosisSafeAppsResponse> {
			await ready()
			await frameLoaded
			// Reuse normal account consent before SDK admission. Concurrent discovery shares the same access approval.
			connected ??= request('eth_requestAccounts').catch((error: unknown) => { connected = undefined; throw error })
			await connected
			try { return { id: envelope.id, success: true, version: GNOSIS_SAFE_APPS_RESPONSE_VERSION, data: await execute(envelope) } } catch (error: unknown) {
				return { id: envelope.id, success: false, version: GNOSIS_SAFE_APPS_RESPONSE_VERSION, error: error instanceof Error ? error.message : String(error) }
			}
		},
		frameLoaded: () => resolveFrameLoaded?.(),
		disconnect() { resolveFrameLoaded?.(); stop(); port.disconnect() },
	}
}
