import { useEffect } from 'preact/hooks'
import type { ComponentChildren } from 'preact'
import { useSignal } from '@preact/signals'
import { MessageToPopup } from '../../types/interceptor-messages.js'
import type { PendingWatchAssetRequest } from '../../types/user-interface-types.js'
import { sendPopupMessageToBackgroundPage, sendPopupReadyAndListening } from '../../background/backgroundUtils.js'
import { noReplyExpectingBrowserRuntimeOnMessageListener } from '../../utils/browser.js'
import { sanitizeStoredWebsiteIcon } from '../../utils/websiteIcons.js'
import { SignerLogoText, getPrettySignerName } from '../subcomponents/signers.js'
import { SmallAddress } from '../subcomponents/address.js'

function AssetField({ label, value }: { label: string, value: ComponentChildren }) {
	return <>
		<span style = 'color: var(--subtitle-text-color)'>{ label }</span>
		<span style = 'color: var(--text-color); overflow-wrap: anywhere; text-align: right'>{ value }</span>
	</>
}

type Comparison = 'match' | 'different' | 'missing'

function ComparisonBadge({ comparison, children }: { comparison: Comparison, children: ComponentChildren }) {
	const className = comparison === 'match' ? 'tag is-success' : comparison === 'different' ? 'tag is-danger' : 'tag'
	return <span class = { className } style = 'margin-left: 7px; white-space: nowrap'>{ children }</span>
}

function ComparedAssetField({ label, requestedValue, onChainValue }: { label: string, requestedValue: string | undefined, onChainValue: string }) {
	const comparison: Comparison = requestedValue === undefined ? 'missing' : requestedValue === onChainValue ? 'match' : 'different'
	return <AssetField label = { label } value = { <span>
		<span>{ requestedValue ?? 'Not provided' }</span>
		<ComparisonBadge comparison = { comparison }>
			{ comparison === 'match' ? 'Matches on-chain' : comparison === 'different' ? 'Differs from on-chain' : 'Not provided' }
		</ComparisonBadge>
		{ comparison === 'match' ? <></> : <small style = 'display: block; color: var(--subtitle-text-color); margin-top: 3px'>{ `On-chain: ${ onChainValue }` }</small> }
	</span> }/>
}

function WatchAssetImage({ pendingRequest, busy, chooseImage }: {
	pendingRequest: PendingWatchAssetRequest,
	busy: boolean,
	chooseImage: (action: 'downloadImage' | 'removeImage') => void,
}) {
	const imageUrl = pendingRequest.requestedAsset.options.image
	if (imageUrl === undefined) return <AssetField label = 'Image hint' value = { <span>Not provided <ComparisonBadge comparison = 'missing'>Not provided</ComparisonBadge></span> }/>
	return <>
		<AssetField label = 'Image hint' value = { <span class = 'is-family-monospace'>{ imageUrl }</span> }/>
		<span></span>
		<span style = 'text-align: right'>
			{ pendingRequest.token.logoUri === undefined ? <button class = 'button is-small is-link is-light' disabled = { busy } onClick = { () => chooseImage('downloadImage') }>
				{ busy ? 'Downloading image…' : 'Download and use image' }
			</button> : <span style = 'display: inline-flex; align-items: center; gap: 7px; justify-content: flex-end'>
				<img src = { pendingRequest.token.logoUri } width = '24' height = '24' style = 'width: 24px; height: 24px; object-fit: contain'/>
				<span><ComparisonBadge comparison = 'match'>Ready to save</ComparisonBadge></span>
				<button class = 'button is-small' disabled = { busy } onClick = { () => chooseImage('removeImage') }>Remove</button>
			</span> }
			{ pendingRequest.imageDownloadError === undefined ? <></> : <small style = 'display: block; color: var(--negative-color); margin-top: 5px'>{ pendingRequest.imageDownloadError }</small> }
		</span>
	</>
}

export function WatchAssetDetails({ pendingRequest, imageBusy = false, chooseImage = () => undefined }: {
	pendingRequest: PendingWatchAssetRequest,
	imageBusy?: boolean,
	chooseImage?: (action: 'downloadImage' | 'removeImage') => void,
}) {
	const { requestedAsset, token, website, contractAddressEntry } = pendingRequest
	const activeChainId = typeof token.chainId === 'bigint' ? token.chainId.toString() : '1'
	const requestedChainId = requestedAsset.options.chainId?.toString()
	return <>
		<p style = 'color: var(--text-color); text-align: center; margin-bottom: 12px'>
			<b>{ website.websiteOrigin }</b> wants to add an asset.
		</p>
		<section style = 'background-color: var(--alpha-005); border-radius: 4px; padding: 10px; margin-bottom: 12px'>
			<h2 style = 'color: var(--text-color); font-weight: 600; margin-bottom: 7px'>Request details</h2>
			<div style = 'display: grid; grid-template-columns: max-content minmax(0, 1fr); column-gap: 12px; row-gap: 5px; font-size: 0.85rem'>
				<AssetField label = 'Asset type' value = { <span>{ requestedAsset.type } <ComparisonBadge comparison = 'match'>ERC-20 verified</ComparisonBadge></span> }/>
				<AssetField label = 'Contract' value = { <span style = 'display: inline-flex; justify-content: flex-end'><SmallAddress addressBookEntry = { contractAddressEntry } renameAddressCallBack = { () => undefined } noEditAddress = { true }/></span> }/>
				<AssetField label = 'Chain ID' value = { <span>
					{ requestedChainId ?? activeChainId }
					<ComparisonBadge comparison = 'match'>{ requestedChainId === undefined ? 'Uses active chain' : 'Matches active chain' }</ComparisonBadge>
				</span> }/>
				<ComparedAssetField label = 'Symbol hint' requestedValue = { requestedAsset.options.symbol } onChainValue = { token.symbol }/>
				<ComparedAssetField label = 'Decimals hint' requestedValue = { requestedAsset.options.decimals?.toString() } onChainValue = { token.decimals.toString() }/>
				<WatchAssetImage pendingRequest = { pendingRequest } busy = { imageBusy } chooseImage = { chooseImage }/>
			</div>
			<p style = 'color: var(--disabled-text-color); font-size: 0.75rem; margin-top: 9px'>Website hints are compared with contract metadata. Downloading the image is optional; it is saved only if you add the token.</p>
		</section>
	</>
}

export function WatchAssetActions({ forwardToSigner, submitting, choose }: {
	forwardToSigner: PendingWatchAssetRequest['forwardToSigner'],
	submitting: boolean,
	choose: (action: 'add' | 'reject' | 'forward') => void,
}) {
	return <div style = 'display: flex; gap: 8px; justify-content: center; flex-wrap: wrap'>
		<button class = 'button is-danger' disabled = { submitting } onClick = { () => choose('reject') }>Don't add</button>
		<button class = 'button is-link' disabled = { submitting || forwardToSigner === undefined } onClick = { () => choose('forward') }>
			{ forwardToSigner === undefined
				? <SignerLogoText signerName = 'NoSignerDetected' text = 'Forward to wallet' reserveLogoSpace = { true }/>
				: <SignerLogoText signerName = { forwardToSigner.signerName } text = { `Forward to ${ getPrettySignerName(forwardToSigner.signerName) }` } reserveLogoSpace = { true }/> }
		</button>
		<button class = 'button is-primary' disabled = { submitting } onClick = { () => choose('add') }>Add to address book</button>
	</div>
}

export function WatchAsset() {
	const request = useSignal<PendingWatchAssetRequest | undefined>(undefined)
	const submitting = useSignal(false)
	const imageBusy = useSignal(false)

	useEffect(() => {
		function popupMessageListener(message: unknown): false {
			const parsed = MessageToPopup.safeParse(message)
			if (!parsed.success || parsed.value.method !== 'popup_WatchAssetRequest') return false
			request.value = parsed.value.data
			submitting.value = false
			imageBusy.value = false
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

	async function chooseImage(action: 'downloadImage' | 'removeImage') {
		if (request.value === undefined || imageBusy.value || submitting.value) return
		imageBusy.value = true
		try {
			await sendPopupMessageToBackgroundPage({
				method: 'popup_watchAssetDialog',
				data: { action, uniqueRequestIdentifier: request.value.request.uniqueRequestIdentifier },
			})
		} finally {
			imageBusy.value = false
		}
	}

	if (request.value === undefined) return <main></main>
	const { website, forwardToSigner } = request.value
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
				<WatchAssetDetails pendingRequest = { request.value } imageBusy = { imageBusy.value || submitting.value } chooseImage = { (action) => void chooseImage(action) }/>
				<WatchAssetActions forwardToSigner = { forwardToSigner } submitting = { submitting.value || imageBusy.value } choose = { (action) => void choose(action) }/>
			</div>
		</div>
	</main>
}
