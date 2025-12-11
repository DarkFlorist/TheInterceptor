import { useEffect } from 'preact/hooks'
import { MessageToPopup } from '../../types/interceptor-messages.js'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import { tryFocusingTabOrWindow } from '../ui-utils.js'
import { PendingFetchSimulationStackRequestPromise } from '../../types/user-interface-types.js'
import { useSignal } from '@preact/signals'

export function FetchSimulationStack() {
	const changeRequest = useSignal<PendingFetchSimulationStackRequestPromise | undefined>(undefined)

	useEffect(() => {
		function popupMessageListener(msg: unknown) {
			const maybeParsed = MessageToPopup.safeParse(msg)
			if (!maybeParsed.success) return // not a message we are interested in
			const parsed = maybeParsed.value
			if (parsed.method !== 'popup_fetchSimulationStackRequest') return
			changeRequest.value = parsed.data
		}
		browser.runtime.onMessage.addListener(popupMessageListener)
		return () => browser.runtime.onMessage.removeListener(popupMessageListener)
	})


	useEffect(() => { sendPopupMessageToBackgroundPage({ method: 'popup_fetchSimulationStackRequestReadyAndListening' }) }, [])

	async function approve() {
		if (changeRequest.value === undefined) return
		await tryFocusingTabOrWindow({ type: 'tab', id: changeRequest.value.uniqueRequestIdentifier.requestSocket.tabId })
		await sendPopupMessageToBackgroundPage({ method: 'popup_fetchSimulationStackRequestConfirmation', data: { accept: true, uniqueRequestIdentifier: changeRequest.value.uniqueRequestIdentifier, simulationStackVersion: changeRequest.value?.simulationStackVersion } })
	}

	async function reject() {
		if (changeRequest.value === undefined) return
		await tryFocusingTabOrWindow({ type: 'tab', id: changeRequest.value.uniqueRequestIdentifier.requestSocket.tabId })
		await sendPopupMessageToBackgroundPage({ method: 'popup_fetchSimulationStackRequestConfirmation', data: { accept: false, uniqueRequestIdentifier: changeRequest.value.uniqueRequestIdentifier, simulationStackVersion: changeRequest.value?.simulationStackVersion } })
	}

	if (changeRequest.value === undefined) return <main></main>
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
							Interceptor Simulation Stack Request
						</p>
					</div>
				</header>
				<div class = 'card-content'>
					<article class = 'media'>
						{
							changeRequest.value.website.icon === undefined
								? <></>
								: <figure class = 'media-left' style = 'margin: auto; display: block; padding: 20px'>
									<div class = 'image is-64x64'>
										<img src = { changeRequest.value.website.icon }/>
									</div>
								</figure>
						}
					</article>
					<div class = 'media-content' style = 'padding-bottom: 10px'>
						<div class = 'content'>
							<p className = 'title' style = 'white-space: normal; text-align: center; padding: 10px;'>
								<b>	{ changeRequest.value.website.websiteOrigin } </b>
								would like to retrieve your Simulation Stack
							</p>
						</div>
					</div>
					<div style = 'overflow: auto; display: flex; justify-content: space-around; width: 100%; height: 40px;'>
						<button
							className = { 'button is-danger' }
							style = { 'flex-grow: 1; margin-left: 5px; margin-right: 5px;' }
							onClick = { reject } >
							Don't allow
						</button>
						<button
							className = { 'button is-primary' }
							disabled = { false }
							style = 'flex-grow: 1; margin-left: 5px; margin-right: 5px;'
							onClick = { approve }>
							Allow
						</button>
					</div>
				</div>
			</div>

			<div class = 'content' style = 'height: 0.1px'/>
		</main>
	)
}
