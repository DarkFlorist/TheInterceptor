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
import { AsyncActionButton } from '../subcomponents/AsyncAction.js'

export const WATCH_ASSET_TITLE = 'Add to Address Book Edit Request'

function AssetField({ label, value }: { label: string, value: ComponentChildren }) {
	return <>
		<span class = 'text-subtitle'>{ label }</span>
		<span class = 'watch-asset-field-value'>{ value }</span>
	</>
}

function TokenImageValue({ uri, alt }: { uri: string | undefined, alt: string }) {
	if (uri === undefined) return <>Not set</>
	return <img src = { uri } alt = { alt } width = '32' height = '32' class = 'watch-asset-token-image'/>
}

function ProposedAssetField({ label, currentValue, proposedValue, changes }: {
	label: string,
	currentValue: ComponentChildren,
	proposedValue: ComponentChildren,
	changes: boolean,
}) {
	return <tr>
		<th class = 'watch-asset-row-label'>{ label }</th>
		<td class = 'watch-asset-row-value'>{ currentValue }</td>
		<td class = 'watch-asset-row-value'>{ proposedValue }</td>
		<td>{ changes ? <span class = 'tag is-warning'>Will change</span> : <span class = 'watch-asset-no-change'>No change</span> }</td>
	</tr>
}

function ProposedTokenImage({ pendingRequest }: { pendingRequest: PendingWatchAssetRequest }) {
	if (pendingRequest.selectedImageUri !== undefined) return <TokenImageValue uri = { pendingRequest.selectedImageUri } alt = 'Proposed token image'/>
	if (pendingRequest.imageDownloadError !== undefined) return <small class = 'watch-asset-image-error'>{ pendingRequest.imageDownloadError }</small>
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
		<p class = 'watch-asset-intro'>
			<b>{ website.websiteOrigin }</b> wants to add an asset.
		</p>
		<section class = 'watch-asset-proposal'>
			<h2 class = 'watch-asset-proposal-title'>Asset proposal</h2>
			<div class = 'watch-asset-fields'>
				<AssetField label = 'Contract' value = { <span class = 'watch-asset-contract-address'><SmallAddress addressBookEntry = { currentToken } renameAddressCallBack = { () => undefined } noEditAddress = { true }/></span> }/>
			</div>
			<div class = 'watch-asset-table-scroll'>
				<table class = 'table is-fullwidth watch-asset-table'>
					<thead><tr><th class = 'watch-asset-column-heading'>Field</th><th class = 'watch-asset-column-heading'>Current</th><th class = 'watch-asset-column-heading'>If accepted</th><th class = 'watch-asset-column-heading'>Change</th></tr></thead>
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

export function WalletForwardingResult({ pendingRequest }: { pendingRequest: PendingWatchAssetRequest }) {
	const status = pendingRequest.forwardingStatus
	if (status === undefined || status.status === 'pending') return <></>
	const walletName = pendingRequest.forwardToSigner === undefined ? 'The wallet' : getPrettySignerName(pendingRequest.forwardToSigner.signerName)
	if (status.status === 'error') return <div class = 'notification result-notice result-notice--negative' role = 'alert'>{ status.message }</div>
	return <div class = { `notification result-notice ${ status.accepted ? 'result-notice--positive' : 'result-notice--warning' }` } role = 'status'>
		{ status.accepted ? `${ walletName } added the asset.` : `${ walletName } did not add the asset.` }
	</div>
}

export function WatchAssetActions({ forwardToSigner, forwardingStatus, submitting, choose }: {
	forwardToSigner: PendingWatchAssetRequest['forwardToSigner'],
	forwardingStatus: PendingWatchAssetRequest['forwardingStatus'],
	submitting: boolean,
	choose: (action: 'add' | 'reject' | 'forward') => void,
}) {
	const waitingForWallet = forwardingStatus?.status === 'pending'
	const actionsDisabled = submitting || waitingForWallet
	const signerName = forwardToSigner?.signerName
	return <div class = 'watch-asset-actions'>
		<button class = 'button button--secondary' disabled = { actionsDisabled } onClick = { () => choose('reject') }>Don't add</button>
		<AsyncActionButton
			class = 'button button--secondary'
			state = { waitingForWallet ? 'pending' : 'inactive' }
			disabled = { actionsDisabled || forwardToSigner === undefined }
			onClick = { () => choose('forward') }
			text = { forwardToSigner === undefined
				? <SignerLogoText signerName = 'NoSignerDetected' text = 'Forward to wallet' reserveLogoSpace = { true }/>
				: <SignerLogoText signerName = { forwardToSigner.signerName } text = { `Forward to ${ getPrettySignerName(forwardToSigner.signerName) }` } reserveLogoSpace = { true }/> }
			pendingText = { signerName === undefined ? 'Waiting for wallet...' : `Waiting for ${ getPrettySignerName(signerName) }...` }
		/>
		<button class = 'button is-primary' disabled = { actionsDisabled } onClick = { () => choose('add') }>Add to address book</button>
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
		<div class = 'block watch-asset-window'>
			<header class = 'card-header window-header'>
				<div class = 'card-header-title'><p class = 'paragraph'>{ WATCH_ASSET_TITLE }</p></div>
			</header>
			<div class = 'card-content watch-asset-content'>
				{ websiteIcon === undefined ? <></> : <figure class = 'image is-64x64 watch-asset-website-icon'>
					<img src = { websiteIcon } width = '64' height = '64'/>
				</figure> }
				<WatchAssetDetails pendingRequest = { request.value }/>
				<WalletForwardingResult pendingRequest = { request.value }/>
				<WatchAssetActions forwardToSigner = { forwardToSigner } forwardingStatus = { request.value.forwardingStatus } submitting = { submitting.value } choose = { (action) => void choose(action) }/>
			</div>
		</div>
	</main>
}
