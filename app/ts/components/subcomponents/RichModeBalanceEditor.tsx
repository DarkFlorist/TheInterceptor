import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import type { RichModeTokenController } from '../hooks/useRichModeTokens.js'
import { getDefaultRichTokenAmount, getRichTokenIdentityKey, getRichTokenLabel } from '../../utils/richTokens.js'
import { TrashIcon } from './icons.js'
import { RichAmountEditor, RichBalanceRow } from './RichModeShared.js'

// The balance view of the rich-account dialog: the native amount and the funded tokens of one account. Token selection stays enabled while a save is pending, so leaving an edited amount for it commits the amount and still opens the picker, whose controls wait for the save.
export function RichModeBalanceEditor({ model, feedback, accountName, nativeCurrencyTicker }: { model: RichModeTokenController['editor'], feedback: RichModeTokenController['feedback'], accountName: string, nativeCurrencyTicker: string }) {
	const { addingRichTokens, availableRichTokens, enabledRichTokens, failedAddedRichToken, newlyAddedRichTokenKeys, richBalanceAssetStatusLabel, richNativeAmount, profile } = model.data.value
	const { clearRichTokenError, removeFailedRichTokenSelection, retryFailedRichTokenSelection, saveNativeAmount, saveRichTokenAmount, setNativeAmount, setRichTokenAmount, setRichTokenEnabled, showRichTokenSelection } = model.actions
	const { selectRichTokensButtonRef } = model
	const { richTokenError, richTokenErrorTarget, richTokenPending, richTokenPendingKey, richTokenNotice, richTokenPendingLabel } = feedback.value
	return <div class = 'rich-mode-balance-page'>
		<div class = 'rich-mode-modal-toolbar'>
			<span class = 'rich-mode-count-badge'>{ richBalanceAssetStatusLabel }</span>
			<div class = 'actions'>
				<button type = 'button' class = 'btn btn--ghost is-small' aria-label = 'Open token address book' data-tooltip = 'Open token address book' onClick = { () => { void sendPopupMessageToBackgroundPage({ method: 'popup_openAddressBook' }) } }>
					<span class = 'icon'><img src = '../img/address-book.svg' width = '18' height = '18'/></span>
				</button>
				<button type = 'button' class = 'btn btn--outline is-small' aria-label = 'Select tokens' ref = { selectRichTokensButtonRef } disabled = { profile === undefined || availableRichTokens.length === 0 } onClick = { showRichTokenSelection }>Select tokens</button>
			</div>
		</div>
		{ profile === undefined ? <p class = 'help'>This account has no balance profile.</p> : <>
			<div class = 'rich-mode-balance-rows'>
				<RichBalanceRow
					class = 'rich-mode-balance-row--native'
					label = { nativeCurrencyTicker }
					logoUri = { nativeCurrencyTicker === 'ETH' ? '../img/coins/ethereum.png' : undefined }
					name = 'Native currency'
					balance = { <RichAmountEditor amount = { profile.nativeAmount } defaultAmount = { richNativeAmount } decimals = { 18 } disabled = { richTokenPending } error = { richTokenErrorTarget === 'native' ? richTokenError : undefined } label = { `${ nativeCurrencyTicker } rich amount for ${ accountName }` } unit = { nativeCurrencyTicker } onCommit = { setNativeAmount } onReset = { () => { clearRichTokenError(); void saveNativeAmount(richNativeAmount) } }/> }
				/>
				<div aria-busy = { richTokenPending } aria-label = 'Configured rich tokens' class = 'rich-mode-configured-tokens'>
					{ enabledRichTokens.length !== 0 || addingRichTokens.length !== 0 || failedAddedRichToken !== undefined ? <></> : <div class = 'rich-mode-empty-state'>
						<span class = 'rich-mode-empty-state-icon' aria-hidden = 'true'>+</span>
						<span><strong>Only { nativeCurrencyTicker }</strong><small>Add an address-book token.</small></span>
						<button type = 'button' class = 'btn btn--ghost is-small' disabled = { availableRichTokens.length === 0 } onClick = { showRichTokenSelection }>Select token</button>
					</div> }
					{ addingRichTokens.map((option) => <RichBalanceRow class = 'is-adding' key = { `adding:${ getRichTokenIdentityKey(option) }` } label = { getRichTokenLabel(option) } logoUri = { option.logoUri } name = { option.name } balance = { <span class = 'rich-mode-balance-progress' role = 'status'>{ richTokenPendingKey === getRichTokenIdentityKey(option) ? 'Scanning storage…' : 'Queued' }</span> }/>) }
					{ failedAddedRichToken === undefined ? <></> : <RichBalanceRow
						class = 'is-failed'
						key = { `failed:${ getRichTokenIdentityKey(failedAddedRichToken) }` }
						label = { getRichTokenLabel(failedAddedRichToken) }
						logoUri = { failedAddedRichToken.logoUri }
						name = { richTokenError ?? 'Storage scan failed.' }
						balance = { <button type = 'button' class = 'btn btn--outline is-small' disabled = { richTokenPending } onClick = { retryFailedRichTokenSelection }>Retry</button> }
						action = { <button type = 'button' class = 'btn btn--ghost is-small rich-mode-remove-token' disabled = { richTokenPending } aria-label = { `Remove failed rich token ${ getRichTokenLabel(failedAddedRichToken) }` } data-tooltip = 'Remove token' onClick = { removeFailedRichTokenSelection }><TrashIcon/></button> }
					/> }
					{ enabledRichTokens.map((option) => <RichBalanceRow
						class = { newlyAddedRichTokenKeys.includes(getRichTokenIdentityKey(option)) ? 'is-new' : undefined }
						key = { getRichTokenIdentityKey(option) }
						label = { getRichTokenLabel(option) }
						logoUri = { option.logoUri }
						name = { option.name }
						balance = { <RichAmountEditor amount = { option.amount } autoFocus = { newlyAddedRichTokenKeys[0] === getRichTokenIdentityKey(option) } defaultAmount = { getDefaultRichTokenAmount(option.decimals) } decimals = { Number(option.decimals) } disabled = { !option.enabled || richTokenPending } error = { richTokenErrorTarget === getRichTokenIdentityKey(option) ? richTokenError : undefined } label = { `${ getRichTokenLabel(option) } rich amount` } unit = { option.symbol } onCommit = { input => { void setRichTokenAmount(option, input) } } onReset = { () => { clearRichTokenError(); void saveRichTokenAmount(option, getDefaultRichTokenAmount(option.decimals)) } }/> }
						action = { <button type = 'button' class = 'btn btn--ghost is-small rich-mode-remove-token' data-keeps-amount-edit = '' disabled = { richTokenPending } aria-label = { `Remove rich token ${ getRichTokenLabel(option) }` } data-tooltip = 'Remove token' onClick = { () => { void setRichTokenEnabled(option, false) } }><TrashIcon/></button> }
					/>) }
				</div>
			</div>
		</> }
		{ richTokenPendingLabel === undefined ? <></> : <p class = 'help is-light' role = 'status'>{ richTokenPendingLabel }</p> }
		{ richTokenNotice === undefined ? <></> : <p class = 'help is-light' role = 'status'>{ richTokenNotice }</p> }
		{ richTokenError === undefined || richTokenErrorTarget !== undefined ? <></> : <p class = 'help is-danger'>{ richTokenError }</p> }
	</div>
}
