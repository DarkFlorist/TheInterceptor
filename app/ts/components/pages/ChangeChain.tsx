import { useEffect } from 'preact/hooks'
import { useSignal } from '@preact/signals'
import { ErrorComponent, ErrorCheckBox } from '../subcomponents/Error.js'
import { MessageToPopup } from '../../types/interceptor-messages.js'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import { tryFocusingTabOrWindow } from '../ui-utils.js'
import { PendingChainChangeConfirmationPromise } from '../../types/user-interface-types.js'
import { noReplyExpectingBrowserRuntimeOnMessageListener } from '../../utils/browser.js'

export function ChangeChain() {
	const chainChangeData = useSignal<PendingChainChangeConfirmationPromise | undefined>(undefined)
	const connectAnyway = useSignal<boolean>(false)

	useEffect(() => {
		function popupMessageListener(msg: unknown): false {
			const maybeParsed = MessageToPopup.safeParse(msg)
			if (!maybeParsed.success) return false// not a message we are interested in
			const parsed = maybeParsed.value
			if (parsed.method !== 'popup_ChangeChainRequest') return false
			chainChangeData.value = parsed.data
			return false
		}
		noReplyExpectingBrowserRuntimeOnMessageListener(popupMessageListener)
		return () => browser.runtime.onMessage.removeListener(popupMessageListener)
	}, [])

	useEffect(() => { sendPopupMessageToBackgroundPage({ method: 'popup_changeChainReadyAndListening' }) }, [])

	async function approve() {
		if (chainChangeData.value === undefined) return
		await tryFocusingTabOrWindow({ type: 'tab', id: chainChangeData.value.request.uniqueRequestIdentifier.requestSocket.tabId })
		await sendPopupMessageToBackgroundPage({ method: 'popup_changeChainDialog', data: { accept: true, uniqueRequestIdentifier: chainChangeData.value.request.uniqueRequestIdentifier, rpcNetwork: chainChangeData.value.rpcNetwork } })
	}

	async function reject() {
		if (chainChangeData.value === undefined) return
		await tryFocusingTabOrWindow({ type: 'tab', id: chainChangeData.value.request.uniqueRequestIdentifier.requestSocket.tabId })
		await sendPopupMessageToBackgroundPage({ method: 'popup_changeChainDialog', data: { accept: false, uniqueRequestIdentifier: chainChangeData.value.request.uniqueRequestIdentifier, rpcNetwork: chainChangeData.value.rpcNetwork } })
	}

	if (chainChangeData.value === undefined) return <main></main>
	return (
		<main>
			<div className = 'block' style = 'margin-bottom: 0px; margin: 10px'>
				<header class = 'card-header window-header'>
					<div class = 'card-header-icon unset-cursor'>
						<span class = 'icon'>
							<img src = '../img/access-key.svg'/>
						</span>
					</div>
					<div class = 'card-header-title'>
						<p className = 'paragraph'>
							Chain Change Request
						</p>
					</div>
				</header>
				<div class = 'card-content'>
					<article class = 'media'>
						{
							chainChangeData.value.website.icon === undefined
								? <></>
								: <figure class = 'media-left' style = 'margin: auto; display: block; padding: 20px'>
									<div class = 'image is-64x64'>
										<img src = { chainChangeData.value.website.icon }/>
									</div>
								</figure>
						}
					</article>
					<div class = 'media-content' style = 'padding-bottom: 10px'>
						<div class = 'content'>
							<p className = 'title' style = 'white-space: normal; text-align: center; padding: 10px;'>
								<b>	{ chainChangeData.value.website.websiteOrigin } </b>
								would like to switch to
								<b> { chainChangeData.value.rpcNetwork.name } </b>
							</p>
							{ chainChangeData.value.rpcNetwork.httpsRpc === undefined && chainChangeData.value.simulationMode ?
								<ErrorComponent text = { 'This chain is not supported by The Interceptor. If you want to use this chain anyway. Select Signing mode instead of Simulation mode and attempt to change the chain again. You will then be able to disable The Interceptor and send transactions without its protection.' }/>
							: <></> }
							{ chainChangeData.value.rpcNetwork.httpsRpc === undefined && !chainChangeData.value.simulationMode ?
								<ErrorCheckBox
									text = { 'This chain is not supported by The Interceptor. Would you like to disable The Interceptor and attempt to connect anyway?' }
									checked = { connectAnyway }
								/>
							: <></> }
						</div>
					</div>
					<div style = 'overflow: auto; display: flex; justify-content: space-around; width: 100%; height: 40px;'>
						<button
							className = { 'button is-danger' }
							style = { 'flex-grow: 1; margin-left: 5px; margin-right: 5px;' }
							onClick = { reject } >
							Don't change
						</button>
						<button
							className = { 'button is-primary' }
							disabled = { chainChangeData.value.rpcNetwork.httpsRpc === undefined && ( (!connectAnyway.value && !chainChangeData.value.simulationMode ) || chainChangeData.value.simulationMode ) }
							style = 'flex-grow: 1; margin-left: 5px; margin-right: 5px;'
							onClick = { approve }>
							{ chainChangeData.value.rpcNetwork.httpsRpc !== undefined ? 'Change chain' : 'Disable The Interceptor and change' }
						</button>
					</div>
				</div>
			</div>

			<div class = 'content' style = 'height: 0.1px'/>
		</main>
	)
}
