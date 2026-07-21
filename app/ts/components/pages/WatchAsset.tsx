import { useEffect } from 'preact/hooks'
import { useSignal } from '@preact/signals'
import { MessageToPopup } from '../../types/interceptor-messages.js'
import type { PendingWatchAssetRequest } from '../../types/user-interface-types.js'
import { sendPopupMessageToBackgroundPage, sendPopupReadyAndListening } from '../../background/backgroundUtils.js'
import { noReplyExpectingBrowserRuntimeOnMessageListener } from '../../utils/browser.js'
import { sanitizeStoredWebsiteIcon } from '../../utils/websiteIcons.js'
import { checksummedAddress } from '../../utils/bigint.js'

function AssetField({ label, value, monospace = false }: { label: string, value: string, monospace?: boolean }) {
	return <>
		<span style = 'color: var(--subtitle-text-color)'>{ label }</span>
		<span class = { monospace ? 'is-family-monospace' : undefined } style = 'color: var(--text-color); overflow-wrap: anywhere; text-align: right'>{ value }</span>
	</>
}

export function WatchAssetDetails({ pendingRequest }: { pendingRequest: PendingWatchAssetRequest }) {
	const { requestedAsset, token, website } = pendingRequest
	const requestedChainId = requestedAsset.options.chainId?.toString() ?? 'Not provided (active chain used)'
	const optionalValue = (value: string | number | undefined) => value?.toString() ?? 'Not provided'
	const verifiedChainId = typeof token.chainId === 'bigint' ? token.chainId.toString() : '1'
	return <>
		<p style = 'color: var(--text-color); text-align: center; margin-bottom: 12px'>
			<b>{ website.websiteOrigin }</b> wants to add an asset.
		</p>
		<section style = 'background-color: var(--alpha-005); border-radius: 4px; padding: 10px; margin-bottom: 10px'>
			<h2 style = 'color: var(--text-color); font-weight: 600; margin-bottom: 7px'>Request details</h2>
			<div style = 'display: grid; grid-template-columns: max-content minmax(0, 1fr); column-gap: 12px; row-gap: 5px; font-size: 0.85rem'>
				<AssetField label = 'Asset type' value = { requestedAsset.type }/>
				<AssetField label = 'Contract' value = { checksummedAddress(requestedAsset.options.address) } monospace = { true }/>
				<AssetField label = 'Chain ID' value = { requestedChainId }/>
				<AssetField label = 'Symbol hint' value = { optionalValue(requestedAsset.options.symbol) }/>
				<AssetField label = 'Decimals hint' value = { optionalValue(requestedAsset.options.decimals) }/>
				<AssetField label = 'Image hint' value = { optionalValue(requestedAsset.options.image) } monospace = { true }/>
			</div>
			<p style = 'color: var(--disabled-text-color); font-size: 0.75rem; margin-top: 7px'>Hints are supplied by the website and are shown for review only.</p>
		</section>
		<section style = 'background-color: var(--alpha-005); border-radius: 4px; padding: 10px; margin-bottom: 12px'>
			<h2 style = 'color: var(--text-color); font-weight: 600; margin-bottom: 7px'>Address book entry (verified on-chain)</h2>
			<div style = 'display: grid; grid-template-columns: max-content minmax(0, 1fr); column-gap: 12px; row-gap: 5px; font-size: 0.85rem'>
				<AssetField label = 'Type' value = { token.type }/>
				<AssetField label = 'Name' value = { token.name }/>
				<AssetField label = 'Symbol' value = { token.symbol }/>
				<AssetField label = 'Contract' value = { checksummedAddress(token.address) } monospace = { true }/>
				<AssetField label = 'Decimals' value = { token.decimals.toString() }/>
				<AssetField label = 'Chain ID' value = { verifiedChainId }/>
			</div>
		</section>
	</>
}

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
	const { website, canForward } = request.value
	const websiteIcon = sanitizeStoredWebsiteIcon(website.icon)
	return <main>
		<div class = 'block' style = 'margin-bottom: 0px; margin: 10px'>
			<header class = 'card-header window-header'>
				<div class = 'card-header-title'><p class = 'paragraph'>Asset Request</p></div>
			</header>
			<div class = 'card-content' style = 'padding: 14px'>
				{ websiteIcon === undefined ? <></> : <figure class = 'image is-64x64' style = 'margin: 10px auto 20px'>
					<img src = { websiteIcon } width = '64' height = '64'/>
				</figure> }
				<WatchAssetDetails pendingRequest = { request.value }/>
				<div style = 'display: flex; gap: 8px; justify-content: center; flex-wrap: wrap'>
					<button class = 'button is-danger' disabled = { submitting.value } onClick = { () => void choose('reject') }>Don't add</button>
					{ canForward ? <button class = 'button is-link' disabled = { submitting.value } onClick = { () => void choose('forward') }>Forward to wallet</button> : <></> }
					<button class = 'button is-primary' disabled = { submitting.value } onClick = { () => void choose('add') }>Add to address book</button>
				</div>
			</div>
		</div>
	</main>
}
