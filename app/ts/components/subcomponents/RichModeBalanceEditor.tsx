import type { ReadonlySignal, Signal } from '@preact/signals'
import type { RefObject } from 'preact'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import type { RichAccountBalance, RichTokenOption } from '../../types/richMode.js'
import { getDefaultRichTokenAmount, getRichTokenIdentityKey, getRichTokenLabel } from '../../utils/richTokens.js'
import { TrashIcon } from './icons.js'
import { RichAmountEditor, RichBalanceRow } from './RichModeShared.js'

type RichModeBalanceEditorProps = {
	accountName: string
	addingRichTokens: ReadonlySignal<readonly RichTokenOption[]>
	availableRichTokens: ReadonlySignal<readonly RichTokenOption[]>
	clearRichTokenError: () => void
	enabledRichTokens: ReadonlySignal<readonly RichTokenOption[]>
	failedAddedRichToken: ReadonlySignal<RichTokenOption | undefined>
	nativeCurrencyTicker: string
	newlyAddedRichTokenKeys: Signal<readonly string[]>
	profile: RichAccountBalance | undefined
	removeFailedRichTokenSelection: () => void
	retryFailedRichTokenSelection: () => void
	richBalanceAssetStatusLabel: ReadonlySignal<string>
	richNativeAmount: ReadonlySignal<bigint>
	richTokenError: Signal<string | undefined>
	richTokenErrorTarget: Signal<string | undefined>
	richTokenPending: Signal<boolean>
	richTokenPendingKey: Signal<string | undefined>
	richTokenNotice: Signal<string | undefined>
	richTokenPendingLabel: Signal<string | undefined>
	saveNativeAmount: (amount: bigint) => Promise<void>
	saveRichTokenAmount: (option: RichTokenOption, amount: bigint) => Promise<void>
	selectRichTokensButtonRef: RefObject<HTMLButtonElement>
	setNativeAmount: (input: HTMLInputElement) => void
	setRichTokenAmount: (option: RichTokenOption, input: HTMLInputElement) => Promise<void>
	setRichTokenEnabled: (option: RichTokenOption, enabled: boolean) => Promise<boolean>
	showRichTokenSelection: () => void
}

// The balance view of the rich-account dialog: the native amount and the funded tokens of one account. Token selection stays enabled while a save is pending, so leaving an edited amount for it commits the amount and still opens the picker, whose controls wait for the save.
export function RichModeBalanceEditor({ accountName, addingRichTokens, availableRichTokens, clearRichTokenError, enabledRichTokens, failedAddedRichToken, nativeCurrencyTicker, newlyAddedRichTokenKeys, profile, removeFailedRichTokenSelection, retryFailedRichTokenSelection, richBalanceAssetStatusLabel, richNativeAmount, richTokenError, richTokenErrorTarget, richTokenPending, richTokenPendingKey, richTokenNotice, richTokenPendingLabel, saveNativeAmount, saveRichTokenAmount, selectRichTokensButtonRef, setNativeAmount, setRichTokenAmount, setRichTokenEnabled, showRichTokenSelection }: RichModeBalanceEditorProps) {
	return <div class = 'rich-mode-balance-page'>
		<div class = 'rich-mode-modal-toolbar'>
			<span class = 'rich-mode-count-badge'>{ richBalanceAssetStatusLabel.value }</span>
			<div class = 'actions'>
				<button type = 'button' class = 'btn btn--ghost is-small' aria-label = 'Open token address book' data-tooltip = 'Open token address book' onClick = { () => { void sendPopupMessageToBackgroundPage({ method: 'popup_openAddressBook' }) } }>
					<span class = 'icon'><img src = '../img/address-book.svg' width = '18' height = '18'/></span>
				</button>
				<button type = 'button' class = 'btn btn--outline is-small' aria-label = 'Select tokens' ref = { selectRichTokensButtonRef } disabled = { profile === undefined || availableRichTokens.value.length === 0 } onClick = { showRichTokenSelection }>Select tokens</button>
			</div>
		</div>
		{ profile === undefined ? <p class = 'help'>This account has no balance profile.</p> : <>
			<div class = 'rich-mode-balance-rows'>
				<RichBalanceRow
					class = 'rich-mode-balance-row--native'
					label = { nativeCurrencyTicker }
					logoUri = { nativeCurrencyTicker === 'ETH' ? '../img/coins/ethereum.png' : undefined }
					name = 'Native currency'
					balance = { <RichAmountEditor amount = { profile.nativeAmount } defaultAmount = { richNativeAmount.value } decimals = { 18 } disabled = { richTokenPending.value } error = { richTokenErrorTarget.value === 'native' ? richTokenError.value : undefined } label = { `${ nativeCurrencyTicker } rich amount for ${ accountName }` } unit = { nativeCurrencyTicker } onCommit = { setNativeAmount } onReset = { () => { clearRichTokenError(); void saveNativeAmount(richNativeAmount.value) } }/> }
				/>
				<div aria-busy = { richTokenPending.value } aria-label = 'Configured rich tokens' class = 'rich-mode-configured-tokens'>
					{ enabledRichTokens.value.length !== 0 || addingRichTokens.value.length !== 0 || failedAddedRichToken.value !== undefined ? <></> : <div class = 'rich-mode-empty-state'>
						<span class = 'rich-mode-empty-state-icon' aria-hidden = 'true'>+</span>
						<span><strong>Only { nativeCurrencyTicker }</strong><small>Add an address-book token.</small></span>
						<button type = 'button' class = 'btn btn--ghost is-small' disabled = { availableRichTokens.value.length === 0 } onClick = { showRichTokenSelection }>Select token</button>
					</div> }
					{ addingRichTokens.value.map((option) => <RichBalanceRow class = 'is-adding' key = { `adding:${ getRichTokenIdentityKey(option) }` } label = { getRichTokenLabel(option) } logoUri = { option.logoUri } name = { option.name } balance = { <span class = 'rich-mode-balance-progress' role = 'status'>{ richTokenPendingKey.value === getRichTokenIdentityKey(option) ? 'Scanning storage…' : 'Queued' }</span> }/>) }
					{ failedAddedRichToken.value === undefined ? <></> : <RichBalanceRow
						class = 'is-failed'
						key = { `failed:${ getRichTokenIdentityKey(failedAddedRichToken.value) }` }
						label = { getRichTokenLabel(failedAddedRichToken.value) }
						logoUri = { failedAddedRichToken.value.logoUri }
						name = { richTokenError.value ?? 'Storage scan failed.' }
						balance = { <button type = 'button' class = 'btn btn--outline is-small' disabled = { richTokenPending.value } onClick = { retryFailedRichTokenSelection }>Retry</button> }
						action = { <button type = 'button' class = 'btn btn--ghost is-small rich-mode-remove-token' disabled = { richTokenPending.value } aria-label = { `Remove failed rich token ${ getRichTokenLabel(failedAddedRichToken.value) }` } data-tooltip = 'Remove token' onClick = { removeFailedRichTokenSelection }><TrashIcon/></button> }
					/> }
					{ enabledRichTokens.value.map((option) => <RichBalanceRow
						class = { newlyAddedRichTokenKeys.value.includes(getRichTokenIdentityKey(option)) ? 'is-new' : undefined }
						key = { getRichTokenIdentityKey(option) }
						label = { getRichTokenLabel(option) }
						logoUri = { option.logoUri }
						name = { option.name }
						balance = { <RichAmountEditor amount = { option.amount } autoFocus = { newlyAddedRichTokenKeys.value[0] === getRichTokenIdentityKey(option) } defaultAmount = { getDefaultRichTokenAmount(option.decimals) } decimals = { Number(option.decimals) } disabled = { !option.enabled || richTokenPending.value } error = { richTokenErrorTarget.value === getRichTokenIdentityKey(option) ? richTokenError.value : undefined } label = { `${ getRichTokenLabel(option) } rich amount` } unit = { option.symbol } onCommit = { input => { void setRichTokenAmount(option, input) } } onReset = { () => { clearRichTokenError(); void saveRichTokenAmount(option, getDefaultRichTokenAmount(option.decimals)) } }/> }
						action = { <button type = 'button' class = 'btn btn--ghost is-small rich-mode-remove-token' data-keeps-amount-edit = '' disabled = { richTokenPending.value } aria-label = { `Remove rich token ${ getRichTokenLabel(option) }` } data-tooltip = 'Remove token' onClick = { () => { void setRichTokenEnabled(option, false) } }><TrashIcon/></button> }
					/>) }
				</div>
			</div>
		</> }
		{ richTokenPendingLabel.value === undefined ? <></> : <p class = 'help is-light' role = 'status'>{ richTokenPendingLabel.value }</p> }
		{ richTokenNotice.value === undefined ? <></> : <p class = 'help is-light' role = 'status'>{ richTokenNotice.value }</p> }
		{ richTokenError.value === undefined || richTokenErrorTarget.value !== undefined ? <></> : <p class = 'help is-danger'>{ richTokenError.value }</p> }
	</div>
}
