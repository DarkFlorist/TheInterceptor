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
	readonly frameUrl: string
	readonly frameHidden: boolean
	readonly frameGeneration: number
	readonly lastContextChange?: string
}

const SOURCE_DISCONNECTED_STATUS = 'The original website connection was lost. Retry the connection, or reopen the app from its website.'

// The component owns DOM/source validation; this controller owns the app session and its pending approvals.
export function createNativeGnosisSafeAppsHostController(ports: HostPorts) {
	const view = signal<HostView>({ status: 'Preparing your selected Gnosis Safe…', frameUrl: 'about:blank', frameHidden: true, frameGeneration: 0 })
	const pendingOperations = signal(0)
	// Both the rendered button and its handler read this one rule. A programmatic click cannot abandon an admitted mutation.
	const retryDisabled = computed(() => pendingOperations.value !== 0)
	const update = (patch: Partial<HostView>) => { view.value = { ...view.peek(), ...patch } }
	let stopped = false
	let sourceDisconnected = false
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
	const showError = (error: unknown) => { if (!stopped) update({ status: error instanceof Error ? error.message : String(error) }) }
	const clearHandshake = () => { cancelHandshake?.(); cancelHandshake = undefined }
	const loadFrame = () => {
		receivedHandshake = false
		clearHandshake()
		update({ frameUrl: ports.appUrl, frameHidden: false, frameGeneration: view.peek().frameGeneration + 1, status: 'Waiting for the website’s Gnosis Safe App handshake…' })
		cancelHandshake = ports.schedule(() => {
			if (!receivedHandshake && !stopped) update({ status: 'No Gnosis Safe App handshake received. This website may block embedded pages, require a different parent origin, or not support Gnosis Safe Apps. You can use the original tab or retry.' })
		}, NATIVE_GNOSIS_SAFE_APPS_HOST_TIMING.handshakeTimeoutMs)
	}
	const refresh = async () => {
		if (stopped || sourceDisconnected) return
		if (refreshing !== undefined) return await refreshing
		const snapshotGeneration = generation
		refreshing = (async () => {
			try {
				const response = await ports.request({ id: 'prepare', method: 'getSafeInfo', env: { sdkVersion: GNOSIS_SAFE_APPS_RESPONSE_VERSION } })
				if (stopped || generation !== snapshotGeneration) return
				if (!response.success) throw new Error(typeof response.error === 'string' ? response.error : 'Gnosis Safe preparation failed. Check the selected wallet and approve access in the original tab.')
				if (typeof response.data !== 'object' || response.data === null || !('safeAddress' in response.data) || typeof response.data.safeAddress !== 'string') throw new Error('The selected wallet did not provide Gnosis Safe metadata.')
				const recovered = refreshFailed
				refreshFailed = false
				prepared = { response, at: ports.now() }
				if (view.peek().frameHidden && !pausedForContextChange) loadFrame()
				else if (recovered && !pausedForContextChange) update({ status: receivedHandshake ? 'Wallet information refreshed. The app connection is still active.' : 'Waiting for the website’s Gnosis Safe App handshake…' })
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
		if (pausedForContextChange) { ports.postResponse(failure(request.id, sourceDisconnected ? SOURCE_DISCONNECTED_STATUS : 'The wallet or permissions changed. Retry the connection before making another app request.')); return }
		receivedHandshake = true
		clearHandshake()
		update({ status: 'Gnosis Safe App handshake received. Requests use Interceptor’s normal permissions and approvals.' })
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
			if (!stopped && (!discovery || generation === requestGeneration)) ports.postResponse(response)
		} finally {
			pending--
			if (!discovery) pendingOperations.value--
			if (pausedForContextChange && !retryDisabled.peek()) update({ status: sourceDisconnected ? `Pending requests finished. ${ SOURCE_DISCONNECTED_STATUS }` : 'Pending requests finished. Retry the connection to use the changed wallet or permissions.' })
		}
	}
	const invalidateContext = (changedKeys: readonly string[]) => {
		generation++
		prepared = undefined
		refreshFailed = false
		// Context changes stop admission, but the original frame must survive to receive an already-admitted operation's terminal reply.
		if (retryDisabled.peek()) pausedForContextChange = true
		if (!pausedForContextChange) {
			clearHandshake()
			update({ frameHidden: true, frameUrl: 'about:blank' })
		}
		update({ lastContextChange: changedKeys.join(','), status: sourceDisconnected ? SOURCE_DISCONNECTED_STATUS : pausedForContextChange ? 'Wallet or permissions changed while requests were pending. Finish those requests, then retry the connection.' : 'Wallet or permissions changed. Preparing the app again…' })
		if (!sourceDisconnected) void refresh()
	}
	const disconnectSource = () => {
		if (stopped || sourceDisconnected) return
		sourceDisconnected = true
		cancelRefresh?.()
		cancelRefresh = undefined
		invalidateContext(['sourceTab'])
	}
	const stop = () => {
		stopped = true
		prepared = undefined
		cancelRefresh?.()
		cancelRefresh = undefined
		clearHandshake()
	}
	return {
		view, retryDisabled, receive, invalidateContext, disconnectSource, showError, refresh, stop,
		start: () => {
			if (started || stopped || sourceDisconnected) return
			started = true
			cancelRefresh = ports.repeat(() => { void refresh() }, NATIVE_GNOSIS_SAFE_APPS_HOST_TIMING.metadataRefreshIntervalMs)
			void refresh()
		},
		retry: () => {
			if (stopped || retryDisabled.peek()) return false
			ports.reload()
			return true
		},
	}
}
