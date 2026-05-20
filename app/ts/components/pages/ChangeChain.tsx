import { useEffect } from 'preact/hooks'
import { useSignal } from '@preact/signals'
import { ErrorComponent } from '../subcomponents/Error.js'
import { MessageToPopup } from '../../types/interceptor-messages.js'
import { sendPopupMessageToBackgroundPage, sendPopupReadyAndListening } from '../../background/backgroundUtils.js'
import { tryFocusingTabOrWindow } from '../ui-utils.js'
import { PendingChainChangeConfirmationPromise } from '../../types/user-interface-types.js'
import { noReplyExpectingBrowserRuntimeOnMessageListener } from '../../utils/browser.js'

export function getChangeChainActionState(params: { hasSupportedRpc: boolean, simulationMode: boolean }) {
	if (params.hasSupportedRpc) return {
		approveButtonText: 'Change chain',
		errorText: undefined,
		approveDisabled: false,
	}
	if (params.simulationMode) return {
		approveButtonText: 'Change chain unavailable',
		errorText: 'This chain is not supported by The Interceptor in Simulation mode. Switch to Signing mode and try again if you want to continue without simulation protection.',
		approveDisabled: true,
	}
	return {
		approveButtonText: 'Change chain unavailable',
		errorText: 'This chain is not supported by The Interceptor. This dialog cannot disable it for you. If you want to continue without its protection, disable The Interceptor from the main popup and retry the chain change in your wallet.',
		approveDisabled: true,
	}
}

export function ChangeChain() {
	const chainChangeData = useSignal<PendingChainChangeConfirmationPromise | undefined>(undefined)

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

	useEffect(() => { void sendPopupReadyAndListening('changeChain') }, [])

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
	const actionState = getChangeChainActionState({
		hasSupportedRpc: chainChangeData.value.rpcNetwork.httpsRpc !== undefined,
		simulationMode: chainChangeData.value.simulationMode,
	})
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
							{ actionState.errorText === undefined ? <></> : <ErrorComponent text = { actionState.errorText }/> }
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
							disabled = { actionState.approveDisabled }
							style = 'flex-grow: 1; margin-left: 5px; margin-right: 5px;'
							onClick = { approve }>
							{ actionState.approveButtonText }
						</button>
					</div>
				</div>
			</div>

			<div class = 'content' style = 'height: 0.1px'/>
		</main>
	)
}
