import { useEffect } from 'preact/hooks'
import { useSignal } from '@preact/signals'
import { ErrorComponent } from '../subcomponents/Error.js'
import { MessageToPopup } from '../../types/interceptor-messages.js'
import { sendPopupMessageToBackgroundPage, sendPopupReadyAndListening } from '../../background/backgroundUtils.js'
import { AsyncActionButton } from '../subcomponents/AsyncAction.js'
import { tryFocusingTabOrWindow } from '../ui-utils.js'
import type { PendingChainChangeConfirmationPromise } from '../../types/user-interface-types.js'
import { noReplyExpectingBrowserRuntimeOnMessageListener } from '../../utils/browser.js'
import { sanitizeStoredWebsiteIcon } from '../../utils/websiteIcons.js'
import { createAsyncActionRunner, useAsyncState } from '../../utils/preact-utilities.js'

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
	const { value: approveChainChangeState, waitFor: waitForApproveChainChangeState, reset: resetApproveChainChangeState } = useAsyncState<void>()
	const { value: rejectChainChangeState, waitFor: waitForRejectChainChangeState, reset: resetRejectChainChangeState } = useAsyncState<void>()

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

	async function changeChain(accept: boolean) {
		if (chainChangeData.value === undefined) return
		await tryFocusingTabOrWindow({ type: 'tab', id: chainChangeData.value.request.uniqueRequestIdentifier.requestSocket.tabId })
		await sendPopupMessageToBackgroundPage({ method: 'popup_changeChainDialog', data: { accept, uniqueRequestIdentifier: chainChangeData.value.request.uniqueRequestIdentifier, rpcNetwork: chainChangeData.value.rpcNetwork } })
	}

	const reject = createAsyncActionRunner(
		{ value: rejectChainChangeState, waitFor: waitForRejectChainChangeState, reset: resetRejectChainChangeState },
		async () => { await changeChain(false) }
	)

	const approve = createAsyncActionRunner(
		{ value: approveChainChangeState, waitFor: waitForApproveChainChangeState, reset: resetApproveChainChangeState },
		async () => { await changeChain(true) }
	)

	if (chainChangeData.value === undefined) return <main></main>
	const actionState = getChangeChainActionState({
		hasSupportedRpc: chainChangeData.value.rpcNetwork.httpsRpc !== undefined,
		simulationMode: chainChangeData.value.simulationMode,
	})
	const websiteIcon = sanitizeStoredWebsiteIcon(chainChangeData.value.website.icon)
	return (
		<main>
			<div class = 'block' style = 'margin-bottom: 0px; margin: 10px'>
				<header class = 'card-header window-header'>
					<div class = 'card-header-icon unset-cursor'>
						<span class = 'icon'>
							<img src = '../img/access-key.svg' width = '24' height = '24'/>
						</span>
					</div>
					<div class = 'card-header-title'>
						<p class = 'paragraph'>
							Chain Change Request
						</p>
					</div>
				</header>
				<div class = 'card-content'>
					<article class = 'media'>
						{
							websiteIcon === undefined
								? <></>
								: <figure class = 'media-left' style = 'margin: auto; display: block; padding: 20px'>
									<div class = 'image is-64x64'>
										<img src = { websiteIcon } width = '64' height = '64'/>
									</div>
								</figure>
						}
					</article>
					<div class = 'media-content' style = 'padding-bottom: 10px'>
						<div class = 'content'>
							<p class = 'title' style = 'white-space: normal; text-align: center; padding: 10px;'>
								<b>	{ chainChangeData.value.website.websiteOrigin } </b>
								would like to switch to
								<b> { chainChangeData.value.rpcNetwork.name } </b>
							</p>
							{ actionState.errorText === undefined ? <></> : <ErrorComponent text = { actionState.errorText }/> }
						</div>
					</div>
					<div style = 'overflow: auto; display: flex; justify-content: space-around; width: 100%; height: 40px;'>
						<AsyncActionButton
							class = { 'button is-danger' }
							style = { 'flex-grow: 1; margin-left: 5px; margin-right: 5px;' }
							state = { rejectChainChangeState.value.state }
							text = { `Don't change` }
							pendingText = 'Not changing...'
							onClick = { reject } >
						</AsyncActionButton>
						<AsyncActionButton
							class = { 'button is-primary' }
							disabled = { actionState.approveDisabled }
							style = 'flex-grow: 1; margin-left: 5px; margin-right: 5px;'
							state = { approveChainChangeState.value.state }
							text = { actionState.approveButtonText }
							pendingText = 'Changing chain...'
							onClick = { approve }>
						</AsyncActionButton>
					</div>
				</div>
			</div>

			<div class = 'content' style = 'height: 0.1px'/>
		</main>
	)
}
