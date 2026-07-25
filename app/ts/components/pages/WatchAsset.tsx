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

export const WATCH_ASSET_TITLE = 'Add to Address Book Edit Request'

function AssetField({ label, value }: { label: string, value: ComponentChildren }) {
	return <>
		<span style = 'color: var(--subtitle-text-color)'>{ label }</span>
		<span style = 'color: var(--text-color); overflow-wrap: anywhere; text-align: right'>{ value }</span>
	</>
}

function TokenImageValue({ uri, alt }: { uri: string | undefined, alt: string }) {
	if (uri === undefined) return <>Not set</>
	return <img src = { uri } alt = { alt } width = '32' height = '32' style = 'width: 32px; height: 32px; object-fit: contain'/>
}

function ProposedAssetField({ label, currentValue, proposedValue, changes }: {
	label: string,
	currentValue: ComponentChildren,
	proposedValue: ComponentChildren,
	changes: boolean,
}) {
	return <tr>
		<th style = 'color: var(--subtitle-text-color); font-weight: 400'>{ label }</th>
		<td style = 'color: var(--text-color); overflow-wrap: anywhere'>{ currentValue }</td>
		<td style = 'color: var(--text-color); overflow-wrap: anywhere'>{ proposedValue }</td>
		<td>{ changes ? <span class = 'tag is-warning' style = 'white-space: nowrap'>Will change</span> : <span style = 'color: var(--disabled-text-color); white-space: nowrap'>No change</span> }</td>
	</tr>
}

function ProposedTokenImage({ pendingRequest }: { pendingRequest: PendingWatchAssetRequest }) {
	if (pendingRequest.selectedImageUri !== undefined) return <TokenImageValue uri = { pendingRequest.selectedImageUri } alt = 'Proposed token image'/>
	if (pendingRequest.imageDownloadError !== undefined) return <small style = 'display: block; color: var(--negative-color)'>{ pendingRequest.imageDownloadError }</small>
	return <TokenImageValue uri = { pendingRequest.currentToken.logoUri } alt = 'Current token image'/>
}

export function WatchAssetDetails({ pendingRequest }: { pendingRequest: PendingWatchAssetRequest }) {
	const { currentToken, token, website, selectedImageUri } = pendingRequest
	const currentChainId = currentToken.chainId === 'AllChains' ? 'All chains' : (currentToken.chainId ?? 1n).toString()
	const proposedChainId = typeof token.chainId === 'bigint' ? token.chainId.toString() : '1'
	const currentAssetImage = currentToken.logoUri
	const proposedLogoUri = selectedImageUri ?? currentAssetImage
	const currentTokenIds = currentToken.type === 'ERC20' ? undefined : currentToken.watchedTokenIds ?? []
	const proposedTokenIds = token.type === 'ERC20' ? undefined : token.watchedTokenIds ?? []
	const formatTokenIds = (tokenIds: readonly bigint[] | undefined) => tokenIds === undefined || tokenIds.length === 0 ? 'None' : tokenIds.map((tokenId) => tokenId.toString()).join(', ')
	return <>
		<p style = 'color: var(--text-color); text-align: center; margin-bottom: 12px'>
			<b>{ website.websiteOrigin }</b> wants to add an asset.
		</p>
		<section style = 'background-color: var(--alpha-005); border-radius: 4px; padding: 10px; margin-bottom: 12px'>
			<h2 style = 'color: var(--text-color); font-weight: 600; margin-bottom: 7px'>Asset proposal</h2>
			<div style = 'display: grid; grid-template-columns: max-content minmax(0, 1fr); column-gap: 12px; row-gap: 5px; font-size: 0.85rem'>
				<AssetField label = 'Contract' value = { <span style = 'display: inline-flex; justify-content: flex-end'><SmallAddress addressBookEntry = { currentToken } renameAddressCallBack = { () => undefined } noEditAddress = { true }/></span> }/>
			</div>
			<div style = 'overflow-x: auto; margin-top: 10px'>
				<table class = 'table is-fullwidth' style = 'background: transparent; font-size: 0.8rem'>
					<thead><tr><th style = 'color: var(--text-color); background-color: var(--alpha-015)'>Field</th><th style = 'color: var(--text-color); background-color: var(--alpha-015)'>Current</th><th style = 'color: var(--text-color); background-color: var(--alpha-015)'>If accepted</th><th style = 'color: var(--text-color); background-color: var(--alpha-015)'>Change</th></tr></thead>
					<tbody>
						<ProposedAssetField label = 'Request type' currentValue = '—' proposedValue = { pendingRequest.requestedAsset.type } changes = { false }/>
						<ProposedAssetField label = 'Asset type' currentValue = { currentToken.type } proposedValue = { token.type } changes = { currentToken.type !== token.type }/>
						<ProposedAssetField label = 'Chain ID' currentValue = { currentChainId } proposedValue = { proposedChainId } changes = { currentChainId !== proposedChainId }/>
						<ProposedAssetField label = 'Name' currentValue = { currentToken.name } proposedValue = { token.name } changes = { currentToken.name !== token.name }/>
						<ProposedAssetField label = 'Symbol' currentValue = { currentToken.symbol } proposedValue = { token.symbol } changes = { currentToken.symbol !== token.symbol }/>
						{ currentToken.type === 'ERC20' && token.type === 'ERC20'
							? <ProposedAssetField label = 'Decimals' currentValue = { currentToken.decimals.toString() } proposedValue = { token.decimals.toString() } changes = { currentToken.decimals !== token.decimals }/>
							: <ProposedAssetField label = 'Token IDs' currentValue = { formatTokenIds(currentTokenIds) } proposedValue = { formatTokenIds(proposedTokenIds) } changes = { formatTokenIds(currentTokenIds) !== formatTokenIds(proposedTokenIds) }/> }
						<ProposedAssetField label = 'Token image' currentValue = { <TokenImageValue uri = { currentAssetImage } alt = 'Current token image'/> } proposedValue = { <ProposedTokenImage pendingRequest = { pendingRequest }/> } changes = { currentAssetImage !== proposedLogoUri }/>
					</tbody>
				</table>
			</div>
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
	const { website, forwardToSigner } = request.value
	const websiteIcon = sanitizeStoredWebsiteIcon(website.icon)
	return <main>
		<div class = 'block' style = 'margin-bottom: 0px; margin: 10px'>
			<header class = 'card-header window-header'>
				<div class = 'card-header-title'><p class = 'paragraph'>{ WATCH_ASSET_TITLE }</p></div>
			</header>
			<div class = 'card-content' style = 'padding: 14px'>
				{ websiteIcon === undefined ? <></> : <figure class = 'image is-64x64' style = 'margin: 10px auto 20px'>
					<img src = { websiteIcon } width = '64' height = '64'/>
				</figure> }
				<WatchAssetDetails pendingRequest = { request.value }/>
				<WatchAssetActions forwardToSigner = { forwardToSigner } submitting = { submitting.value } choose = { (action) => void choose(action) }/>
			</div>
		</div>
	</main>
}
