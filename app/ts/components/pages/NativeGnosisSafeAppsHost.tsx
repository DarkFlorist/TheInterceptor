import { connectNativeGnosisSafeAppsHost } from '../../utils/nativeGnosisSafeAppsConnection.js'
import { NATIVE_GNOSIS_SAFE_APPS_HOST_CONTEXT_PORT, NativeGnosisSafeAppsHostContextChange } from '../../types/nativeGnosisSafeAppsHostContext.js'
import { useEffect, useMemo, useRef } from 'preact/hooks'
import { createNativeGnosisSafeAppsHostController } from './nativeGnosisSafeAppsHostController.js'
import { parseNativeGnosisSafeAppsLaunch } from '../../utils/nativeGnosisSafeAppsHost.js'

export function NativeGnosisSafeAppsHost() {
	const launch = useMemo(() => parseNativeGnosisSafeAppsLaunch(new URLSearchParams(location.search)), [])
	const frame = useRef<HTMLIFrameElement>()
	const connection = useMemo(connectNativeGnosisSafeAppsHost, [])
	const controller = useMemo(() => createNativeGnosisSafeAppsHostController({
		appUrl: launch.appUrl.href,
		request: connection.request,
		postResponse: (response) => { frame.current?.contentWindow?.postMessage(response, launch.appUrl.origin) },
		reload: () => location.reload(),
		now: () => performance.now(),
		schedule: (callback, delay) => { const timer = setTimeout(callback, delay); return () => clearTimeout(timer) },
		repeat: (callback, delay) => { const timer = setInterval(callback, delay); return () => clearInterval(timer) },
	}), [launch, connection])
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
			controller.invalidateContext(change.keys)
		})
		context.onDisconnect.addListener(controller.disconnectExtension)
		void connection.ready().then(controller.start).catch(controller.showError)
		return () => {
			controller.stop()
			connection.disconnect()
			context.onDisconnect.removeListener(controller.disconnectExtension)
			context.disconnect()
			window.removeEventListener('message', receive)
			window.removeEventListener('pagehide', controller.stop)
		}
	}, [controller, launch, connection])
	const view = controller.view.value
	return <section style = { { position: 'fixed', inset: 0, margin: 0, padding: 0, color: 'var(--text-color)' } }>
		<iframe key = { view.frameGeneration } ref = { element => { frame.current = element ?? undefined } } data-host-generation = { view.frameGeneration } title = 'Gnosis Safe App' src = { view.frameUrl } hidden = { view.frameHidden }
			onLoad = { event => {
				const current = controller.view.peek()
				if (current.frameHidden || event.currentTarget.getAttribute('data-host-generation') !== String(current.frameGeneration)) return
				event.currentTarget.setAttribute('data-host-loaded', 'true')
				connection.frameLoaded()
				void controller.refresh()
			} }
			sandbox = 'allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads'
			style = { { width: '100%', height: '100%', display: 'block', border: 0, margin: 0, padding: 0 } }
		/>
		<details data-gnosis-safe-controls open = { view.connectionError === true } style = { { position: 'fixed', right: '8px', bottom: '8px', maxWidth: 'min(440px, calc(100vw - 16px))', background: 'var(--bg-color)', borderRadius: '4px', padding: '6px 10px', zIndex: 1 } }>
			<summary style = { { color: 'inherit', cursor: 'pointer' } }>Gnosis Safe connection</summary>
			<p class = 'paragraph' role = 'status' data-last-context-change = { view.lastContextChange }>{ view.status }</p>
			{ view.connectionError ? <p class = 'paragraph'>Check the selected Gnosis Safe, wallet and network in Interceptor. Enable your wallet for this app, then retry; if embedding is blocked, open the website directly.</p> : <></> }
			<button type = 'button' class = 'btn btn--outline' disabled = { controller.retryDisabled.value } onClick = { () => { controller.retry() } }>Retry connection</button>
			<button type = 'button' class = 'btn btn--outline' disabled = { controller.retryDisabled.value } onClick = { () => { if (!controller.retryDisabled.peek()) location.assign(launch.appUrl.href) } }>Open website directly</button>
		</details>
	</section>
}
