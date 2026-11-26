import { NATIVE_GNOSIS_SAFE_APPS_HOST_CONTEXT_PORT, NativeGnosisSafeAppsHostContextChange } from '../../types/nativeGnosisSafeAppsHostContext.js'
import { NativeGnosisSafeAppsRelayReply } from '../../types/interceptor-reply-messages.js'
import { useEffect, useMemo, useRef } from 'preact/hooks'
import { createNativeGnosisSafeAppsHostController } from './nativeGnosisSafeAppsHostController.js'
import { parseNativeGnosisSafeAppsLaunch, parseNativeGnosisSafeAppsResponse } from '../../utils/nativeGnosisSafeAppsHost.js'
import { useAsyncState } from '../../utils/preact-utilities.js'
import { AsyncActionButton } from '../subcomponents/AsyncAction.js'
import { ErrorComponent } from '../subcomponents/Error.js'
import { NATIVE_GNOSIS_SAFE_APPS_REQUEST } from '../../types/popupMessageProtocol.js'

export function NativeGnosisSafeAppsHost() {
	const launch = useMemo(() => parseNativeGnosisSafeAppsLaunch(new URLSearchParams(location.search)), [])
	const frame = useRef<HTMLIFrameElement>()
	const originalTab = useAsyncState<void>()
	const controller = useMemo(() => createNativeGnosisSafeAppsHostController({
		appUrl: launch.appUrl.href,
		request: async (request) => {
			const id = crypto.randomUUID()
			const response: unknown = await browser.runtime.sendMessage({ method: NATIVE_GNOSIS_SAFE_APPS_REQUEST, data: { sourceTabId: launch.sourceTabId, origin: launch.appUrl.origin, request: { ...request, id } } })
			const relay = NativeGnosisSafeAppsRelayReply.parse(response)
			if (!relay.ok) throw new Error(relay.message)
			const parsed = parseNativeGnosisSafeAppsResponse(relay.response)
			if (parsed === undefined || parsed.id !== id) throw new Error('Interceptor returned an invalid Gnosis Safe App response. Check the original tab and retry.')
			return { ...parsed, id: request.id }
		},
		postResponse: (response) => { frame.current?.contentWindow?.postMessage(response, launch.appUrl.origin) },
		reload: () => location.reload(),
		now: () => performance.now(),
		schedule: (callback, delay) => { const timer = setTimeout(callback, delay); return () => clearTimeout(timer) },
		repeat: (callback, delay) => { const timer = setInterval(callback, delay); return () => clearInterval(timer) },
	}), [launch])
	useEffect(() => {
		const receive = (event: MessageEvent<unknown>) => {
			const current = controller.view.peek()
			const child = frame.current?.contentWindow
			// Ignore the old frame while Preact is committing a changed wallet session.
			if (current.frameHidden || frame.current?.getAttribute('data-host-generation') !== String(current.frameGeneration) || child === undefined || child === null || event.source !== child || event.origin !== launch.appUrl.origin) return
			void controller.receive(event.data).catch(controller.showError)
		}
		window.addEventListener('message', receive)
		window.addEventListener('pagehide', controller.stop, { once: true })
		const context = browser.runtime.connect({ name: NATIVE_GNOSIS_SAFE_APPS_HOST_CONTEXT_PORT })
		context.onMessage.addListener((value: unknown) => {
			const change = NativeGnosisSafeAppsHostContextChange.parse(value)
			if (change.type === 'source-disconnected') controller.disconnectSource()
			else controller.invalidateContext(change.keys)
		})
		context.onDisconnect.addListener(controller.disconnectSource)
		controller.start()
		return () => {
			controller.stop()
			context.onDisconnect.removeListener(controller.disconnectSource)
			context.disconnect()
			window.removeEventListener('message', receive)
			window.removeEventListener('pagehide', controller.stop)
		}
	}, [controller, launch])
	const view = controller.view.value
	return <section style = { { display: 'flex', flexDirection: 'column', minHeight: '100vh', gap: '12px', padding: '16px', boxSizing: 'border-box', color: 'var(--text-color)' } }>
		<h1 class = 'title'>Gnosis Safe App</h1>
		<strong class = 'paragraph'>{ launch.appUrl.origin }</strong>
		<p class = 'paragraph' role = 'status' data-last-context-change = { view.lastContextChange }>{ view.status }</p>
		<p class = 'paragraph'>Keep the original website tab open. Interceptor uses its wallet connection and website permissions for requests and approvals.</p>
		<div style = { { display: 'flex', gap: '12px', flexWrap: 'wrap' } }>
			<AsyncActionButton type = 'button' class = 'btn btn--outline' state = { originalTab.value.value.state } text = 'Show original tab' pendingText = 'Show original tab' keepTextWhilePending
				onClick = { () => originalTab.waitFor(async () => { await browser.tabs.update(launch.sourceTabId, { active: true }) }) }
			/>
			<button type = 'button' class = 'btn btn--outline' disabled = { controller.retryDisabled.value } onClick = { () => { controller.retry() } }>Retry connection</button>
		</div>
		{ originalTab.value.value.state === 'rejected' ? <ErrorComponent text = { `The original tab is unavailable: ${ originalTab.value.value.error.message }` } /> : <></> }
		<iframe key = { view.frameGeneration } ref = { element => { frame.current = element ?? undefined } } data-host-generation = { view.frameGeneration } title = 'Gnosis Safe App' src = { view.frameUrl } hidden = { view.frameHidden }
			sandbox = 'allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads'
			style = { { width: '100%', minHeight: '72vh', flex: '1', border: '1px solid var(--border-color)', borderRadius: '8px' } }
		/>
	</section>
}
