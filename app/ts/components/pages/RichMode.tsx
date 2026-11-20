import { useRichModeTokens, type RichModeTokenInputs } from '../hooks/useRichModeTokens.js'
import type { RenameAddressCallBack } from '../../types/user-interface-types.js'
import { AddressIcon } from '../subcomponents/address.js'
import { InterceptorDialogBody, InterceptorDialogHeader, InterceptorDialogSurface } from '../subcomponents/InterceptorDialog.js'
import { RichModeAccountList } from '../subcomponents/RichModeAccountList.js'
import { RichModeBalanceEditor } from '../subcomponents/RichModeBalanceEditor.js'
import { KEEPS_AMOUNT_EDIT_SELECTOR } from '../subcomponents/RichModeShared.js'
import { RichModeTokenPicker, RichModeTokenPickerFooter } from '../subcomponents/RichModeTokenPicker.js'

type RichModeAccountManagerProps = RichModeTokenInputs & { renameAddressCallBack: RenameAddressCallBack }

// Renders cohesive controller views; funding remains authoritative in the background home snapshot.
export function RichModeAccountManager(props: RichModeAccountManagerProps) {
	const { nativeCurrencyTicker, renameAddressCallBack } = props
	const { accounts, editor, picker, dialog, feedback } = useRichModeTokens(props)
	const { showRichBalanceDialog, showRichTokenPicker, selectedRichAccount, richAccounts, selectedRichAccountIndex, richOperationStatus } = dialog.data.value
	const { closeRichBalanceDialog, hideRichTokenSelection, showAdjacentRichAccount } = dialog.actions

	return <>
		<RichModeAccountList model = { accounts } nativeCurrencyTicker = { nativeCurrencyTicker } renameAddressCallBack = { renameAddressCallBack }/>
		{ !showRichBalanceDialog || selectedRichAccount === undefined
			? <></>
			: <div
				class = 'modal is-active rich-mode-modal-layer'
				onMouseDown = { event => { if (event.target instanceof Element && event.target.closest(KEEPS_AMOUNT_EDIT_SELECTOR) !== null) event.preventDefault() } }
				onKeyDown = { event => {
					if (event.key !== 'Escape' || feedback.value.richTokenPending) return
					showRichTokenPicker ? hideRichTokenSelection() : closeRichBalanceDialog()
				} }
			>
				<InterceptorDialogSurface ariaLabel = { showRichTokenPicker ? `Select tokens for ${ selectedRichAccount.addressBookEntry.name }` : `Balance editor for ${ selectedRichAccount.addressBookEntry.name }` } class = 'rich-mode-modal-card' onBackdropClick = { closeRichBalanceDialog } size = 'large'>
					<InterceptorDialogHeader
						accessory = { <div class = 'rich-mode-header-tools'>
							{ richOperationStatus === undefined ? <></> : <span class = { `rich-mode-save-status ${ richOperationStatus.className }` } role = 'status'>{ richOperationStatus.label }</span> }
							{ showRichTokenPicker || richAccounts.length < 2 ? <></> : <div class = 'rich-mode-header-account-switcher' aria-label = 'Rich account navigation'>
								<button type = 'button' class = 'btn btn--ghost is-small' aria-label = 'Previous rich account' disabled = { feedback.value.richTokenPending } onClick = { () => { showAdjacentRichAccount(-1) } }>‹</button>
								<span>{ (selectedRichAccountIndex + 1).toString() } / { richAccounts.length.toString() }</span>
								<button type = 'button' class = 'btn btn--ghost is-small' aria-label = 'Next rich account' disabled = { feedback.value.richTokenPending } onClick = { () => { showAdjacentRichAccount(1) } }>›</button>
							</div> }
						</div> }
						close = { closeRichBalanceDialog }
						closeDisabled = { feedback.value.richTokenPending }
						closeLabel = 'Close balance manager'
						icon = '../img/address-book.svg'
						iconContent = { <AddressIcon address = { selectedRichAccount.addressBookEntry.address } logoUri = { 'logoUri' in selectedRichAccount.addressBookEntry ? selectedRichAccount.addressBookEntry.logoUri : undefined } isBig = { false } backgroundColor = 'var(--surface-dark-color)'/> }
						title = 'Balances'
						subtitle = { selectedRichAccount.addressBookEntry.name }
					/>
					<InterceptorDialogBody class = { `rich-mode-dialog-body${ showRichTokenPicker ? ' is-token-view' : '' }` }>
						{ !showRichTokenPicker
							? <RichModeBalanceEditor model = { editor } feedback = { feedback } accountName = { selectedRichAccount.addressBookEntry.name } nativeCurrencyTicker = { nativeCurrencyTicker }/>
							: <RichModeTokenPicker model = { picker } feedback = { feedback } accountName = { selectedRichAccount.addressBookEntry.name }/> }
					</InterceptorDialogBody>
					{ !showRichTokenPicker ? <></> : <RichModeTokenPickerFooter model = { picker } feedback = { feedback }/> }
				</InterceptorDialogSurface>
			</div>
		}
	</>
}
