import { NATIVE_GNOSIS_SAFE_APPS_HOST_TIMING } from '../../utils/nativeGnosisSafeAppsHostTiming.js'
import { computed, signal } from '@preact/signals'
import { GNOSIS_SAFE_APPS_PENDING_REQUEST_LIMIT, GNOSIS_SAFE_APPS_RESPONSE_VERSION, createGnosisSafeAppsErrorResponse, isNativeGnosisSafeAppsDiscovery, parseNativeGnosisSafeAppsRequest, type NativeGnosisSafeAppsRequest, type NativeGnosisSafeAppsResponse } from '../../utils/nativeGnosisSafeAppsHost.js'

type HostPorts = {
	readonly appUrl: string
	readonly request: (request: NativeGnosisSafeAppsRequest) => Promise<NativeGnosisSafeAppsResponse>
	readonly postResponse: (response: NativeGnosisSafeAppsResponse) => void
	readonly reload: () => void
	readonly now: () => number
	readonly schedule: (callback: () => void, delay: number) => () => void
	readonly repeat: (callback: () => void, delay: number) => () => void
}

type HostView = {
	readonly status: string
	readonly connectionError?: boolean
	readonly frameUrl: string
	readonly frameHidden: boolean
	readonly frameGeneration: number
	readonly lastContextChange?: string
}

const EXTENSION_DISCONNECTED_STATUS = 'The extension connection was lost. Retry the connection to reconnect to Interceptor.'

// The component owns DOM/source validation; this controller owns the app session and its pending approvals.
export function createNativeGnosisSafeAppsHostController(ports: HostPorts) {
	const view = signal<HostView>({ status: 'Preparing your selected Gnosis Safe…', frameUrl: 'about:blank', frameHidden: true, frameGeneration: 0 })
	const pendingOperations = signal(0)
	// Both the rendered button and its handler read this one rule. A programmatic click cannot abandon an admitted mutation.
	const retryDisabled = computed(() => pendingOperations.value !== 0)
	const update = (patch: Partial<HostView>) => { view.value = { ...view.peek(), ...patch } }
	let stopped = false
	let extensionDisconnected = false
	let started = false
	let generation = 0
	let prepared: { readonly response: NativeGnosisSafeAppsResponse, readonly at: number } | undefined
	let refreshing: Promise<void> | undefined
	let refreshFailed = false
	let pending = 0
	let pausedForContextChange = false
	let receivedHandshake = false
	let cancelHandshake: (() => void) | undefined
	let cancelRefresh: (() => void) | undefined
	const failure = (id: string, error: unknown): NativeGnosisSafeAppsResponse => createGnosisSafeAppsErrorResponse({ id }, error instanceof Error ? error.message : String(error))
	const showError = (error: unknown) => { if (!stopped) update({ connectionError: true, status: error instanceof Error ? error.message : String(error) }) }
	const clearHandshake = () => { cancelHandshake?.(); cancelHandshake = undefined }
	const loadFrame = () => {
		receivedHandshake = false
		clearHandshake()
		update({ frameUrl: ports.appUrl, frameHidden: false, frameGeneration: view.peek().frameGeneration + 1, status: 'Waiting for the website’s Gnosis Safe App handshake…', connectionError: false })
		cancelHandshake = ports.schedule(() => {
			if (!receivedHandshake && !stopped) update({ connectionError: true, status: 'No Gnosis Safe App handshake received. This website may block embedded pages, require a different parent origin, or not support Gnosis Safe Apps. Retry the connection or open the website directly.' })
		}, NATIVE_GNOSIS_SAFE_APPS_HOST_TIMING.handshakeTimeoutMs)
	}
	const refresh = async () => {
		if (stopped || extensionDisconnected) return
		if (refreshing !== undefined) return await refreshing
		const snapshotGeneration = generation
		refreshing = (async () => {
			try {
				const response = await ports.request({ id: 'prepare', method: 'getSafeInfo', env: { sdkVersion: GNOSIS_SAFE_APPS_RESPONSE_VERSION } })
				if (stopped || generation !== snapshotGeneration) return
				if (!response.success) throw new Error(typeof response.error === 'string' ? response.error : 'Gnosis Safe preparation failed. Select a Gnosis Safe in Interceptor and approve website access when prompted.')
				if (typeof response.data !== 'object' || response.data === null || !('safeAddress' in response.data) || typeof response.data.safeAddress !== 'string') throw new Error('The selected wallet did not provide Gnosis Safe metadata.')
				const recovered = refreshFailed
				refreshFailed = false
				prepared = { response, at: ports.now() }
				if (view.peek().frameHidden && !pausedForContextChange) loadFrame()
				else if (recovered && !pausedForContextChange) update({ connectionError: false, status: receivedHandshake ? 'Wallet information refreshed. The app connection is still active.' : 'Waiting for the website’s Gnosis Safe App handshake…' })
			} catch (error: unknown) {
				if (generation !== snapshotGeneration || stopped) return
				// Refresh failures do not invalidate the app session or extend its cached metadata lifetime. Explicit context changes alone clear preparation and pause or replace the frame.
				refreshFailed = true
				if (pausedForContextChange) showError(`Wallet or permissions changed. Retry the connection before making another app request. ${ error instanceof Error ? error.message : String(error) }`)
				else showError(error)
			}
		})().finally(() => {
			refreshing = undefined
			if (!stopped && generation !== snapshotGeneration) void refresh()
		})
		await refreshing
	}
	const receive = async (value: unknown) => {
		if (stopped || view.peek().frameHidden) return
		const request = parseNativeGnosisSafeAppsRequest(value)
		if (request === undefined) return
		if (pausedForContextChange) { ports.postResponse(failure(request.id, extensionDisconnected ? EXTENSION_DISCONNECTED_STATUS : 'The wallet or permissions changed. Retry the connection before making another app request.')); return }
		receivedHandshake = true
		clearHandshake()
		update({ connectionError: false, status: 'Gnosis Safe App handshake received. Requests use Interceptor’s normal permissions and approvals.' })
		if (pending >= GNOSIS_SAFE_APPS_PENDING_REQUEST_LIMIT) { ports.postResponse(failure(request.id, 'Too many pending Gnosis Safe App requests.')); return }
		if (request.method === 'getSafeInfo' && prepared !== undefined && ports.now() - prepared.at <= NATIVE_GNOSIS_SAFE_APPS_HOST_TIMING.preparedMetadataLifetimeMs) {
			ports.postResponse({ ...prepared.response, id: request.id })
			return
		}
		pending++
		const discovery = isNativeGnosisSafeAppsDiscovery(request.method)
		const requestGeneration = generation
		if (!discovery) pendingOperations.value++
		try {
			let response: NativeGnosisSafeAppsResponse
			try { response = await ports.request(request) } catch (error: unknown) { response = failure(request.id, error) }
			if (!stopped && (!discovery || generation === requestGeneration)) {
				ports.postResponse(response)
			}
		} finally {
			pending--
			if (!discovery) pendingOperations.value--
			if (pausedForContextChange && !retryDisabled.peek()) update({ status: extensionDisconnected ? `Pending requests finished. ${ EXTENSION_DISCONNECTED_STATUS }` : 'Pending requests finished. Retry the connection to use the changed wallet or permissions.' })
		}
	}
	const invalidateContext = (changedKeys: readonly string[]) => {
		generation++
		clearHandshake()
		prepared = undefined
		refreshFailed = false
		// Context changes stop admission, but the original frame must survive to receive an already-admitted operation's terminal reply.
		if (retryDisabled.peek() || changedKeys.some((key) => key !== 'websiteAccess')) pausedForContextChange = true
		// Keep the real app frame and wallet bridge alive. Background admission rechecks the changed permissions/account before every request.

		update({ lastContextChange: changedKeys.join(','), connectionError: pausedForContextChange, status: extensionDisconnected ? EXTENSION_DISCONNECTED_STATUS : pausedForContextChange ? retryDisabled.peek() ? 'Wallet or permissions changed while requests were pending. Finish those requests, then retry the connection.' : 'Wallet or network changed. Retry the connection so the app uses the current selection.' : 'Website permissions changed. Checking access again…' })
		if (!extensionDisconnected) void refresh()
	}
	const disconnectExtension = () => {
		if (stopped || extensionDisconnected) return
		extensionDisconnected = true
		pausedForContextChange = true
		cancelRefresh?.()
		cancelRefresh = undefined
		invalidateContext(['extensionConnection'])
	}
	const stop = () => {
		stopped = true
		prepared = undefined
		cancelRefresh?.()
		cancelRefresh = undefined
		clearHandshake()
	}
	return {
		view, retryDisabled, receive, invalidateContext, disconnectExtension, showError, refresh, stop,
		start: () => {
			if (started || stopped || extensionDisconnected) return
			started = true
			cancelRefresh = ports.repeat(() => { void refresh() }, NATIVE_GNOSIS_SAFE_APPS_HOST_TIMING.metadataRefreshIntervalMs)
			loadFrame()
		},
		retry: () => {
			if (stopped || retryDisabled.peek()) return false
			ports.reload()
			return true
		},
	}
}
