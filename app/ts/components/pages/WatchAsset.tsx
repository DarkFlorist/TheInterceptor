import { useEffect } from 'preact/hooks'
import { useSignal } from '@preact/signals'
import { MessageToPopup } from '../../types/interceptor-messages.js'
import type { PendingWatchAssetRequest } from '../../types/user-interface-types.js'
import { sendPopupMessageToBackgroundPage, sendPopupReadyAndListening } from '../../background/backgroundUtils.js'
import { noReplyExpectingBrowserRuntimeOnMessageListener } from '../../utils/browser.js'
import { sanitizeStoredWebsiteIcon } from '../../utils/websiteIcons.js'
import { checksummedAddress } from '../../utils/bigint.js'

export function WatchAsset() {
	const request = useSignal<PendingWatchAssetRequest | undefined>(undefined)
	const submitting = useSignal(false)

	useEffect(() => {
		function popupMessageListener(message: unknown): false {
			const parsed = MessageToPopup.safeParse(message)
			if (!parsed.success || parsed.value.method !== 'popup_WatchAssetRequest') return false
			request.value = parsed.value.data
			submitting.value = false
			return false
		}
		noReplyExpectingBrowserRuntimeOnMessageListener(popupMessageListener)
		return () => browser.runtime.onMessage.removeListener(popupMessageListener)
	}, [])

	useEffect(() => { void sendPopupReadyAndListening('watchAsset') }, [])

	async function choose(action: 'add' | 'reject' | 'forward') {
		if (request.value === undefined || submitting.value) return
		submitting.value = true
		try {
			await sendPopupMessageToBackgroundPage({
				method: 'popup_watchAssetDialog',
				data: { action, uniqueRequestIdentifier: request.value.request.uniqueRequestIdentifier },
			})
		} finally {
			submitting.value = false
		}
	}

	if (request.value === undefined) return <main></main>
	const { token, website, canForward } = request.value
	const websiteIcon = sanitizeStoredWebsiteIcon(website.icon)
	return <main>
		<div class = 'block' style = 'margin-bottom: 0px; margin: 10px'>
			<header class = 'card-header window-header'>
				<div class = 'card-header-title'><p class = 'paragraph'>Asset Request</p></div>
			</header>
			<div class = 'card-content'>
				{ websiteIcon === undefined ? <></> : <figure class = 'image is-64x64' style = 'margin: 10px auto 20px'>
					<img src = { websiteIcon } width = '64' height = '64'/>
				</figure> }
				<div class = 'content' style = 'text-align: center'>
					<p><b>{ website.websiteOrigin }</b> would like you to watch this asset:</p>
					<p class = 'title is-4'>{ token.name } ({ token.symbol })</p>
					<p class = 'is-family-monospace' style = 'overflow-wrap: anywhere'>{ checksummedAddress(token.address) }</p>
					<p>Decimals: { token.decimals.toString() } · Chain ID: { typeof token.chainId === 'bigint' ? token.chainId.toString() : '1' }</p>
					<p>The token details above were read from the contract. Adding it stores the token in The Interceptor address book.</p>
				</div>
				<div style = 'display: flex; gap: 8px; justify-content: center; flex-wrap: wrap'>
					<button class = 'button is-danger' disabled = { submitting.value } onClick = { () => void choose('reject') }>Don't add</button>
					{ canForward ? <button class = 'button is-link' disabled = { submitting.value } onClick = { () => void choose('forward') }>Forward to wallet</button> : <></> }
					<button class = 'button is-primary' disabled = { submitting.value } onClick = { () => void choose('add') }>Add to address book</button>
				</div>
			</div>
		</div>
	</main>
}
