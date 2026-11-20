import type { ReadonlySignal, Signal } from '@preact/signals'
import type { JSX } from 'preact'
import type { RichTokenOption } from '../../types/richMode.js'
import { addressString } from '../../utils/bigint.js'
import { getRichTokenIdentityKey, getRichTokenLabel } from '../../utils/richTokens.js'
import { InterceptorDialogFooter } from './InterceptorDialog.js'
import { RichTokenIcon } from './RichModeShared.js'

export type RichTokenFilter = 'All' | 'ERC20' | 'ERC1155'

function HighlightedRichTokenText({ query, text }: { query: string, text: string }) {
	const normalizedQuery = query.trim().toLowerCase()
	const matchIndex = normalizedQuery === '' ? -1 : text.toLowerCase().indexOf(normalizedQuery)
	if (matchIndex === -1) return <>{ text }</>
	return <>{ text.slice(0, matchIndex) }<mark>{ text.slice(matchIndex, matchIndex + normalizedQuery.length) }</mark>{ text.slice(matchIndex + normalizedQuery.length) }</>
}

type RichModeTokenPickerProps = {
	accountName: string
	activeRichTokenIndex: ReadonlySignal<number>
	availableRichTokens: ReadonlySignal<readonly RichTokenOption[]>
	failedAddedRichToken: ReadonlySignal<RichTokenOption | undefined>
	handleRichTokenSearchKeyDown: (event: JSX.TargetedKeyboardEvent<HTMLInputElement>) => void
	hideRichTokenSelection: () => void
	highlightedRichTokenIndex: Signal<number>
	matchingAvailableRichTokens: ReadonlySignal<readonly RichTokenOption[]>
	recentRichTokenKeys: Signal<readonly string[]>
	richTokenError: Signal<string | undefined>
	richTokenFilter: Signal<RichTokenFilter>
	richTokenPending: Signal<boolean>
	richTokenPendingKey: Signal<string | undefined>
	richTokenResultsScrollTop: Signal<number>
	richTokenSearch: Signal<string>
	selectedAvailableRichTokens: ReadonlySignal<readonly RichTokenOption[]>
	selectedRichTokenKeys: Signal<readonly string[]>
	toggleRichTokenSelection: (option: RichTokenOption) => void
}

// The token-selection view of the rich-account dialog: search and pick address-book tokens to fund for one account.
export function RichModeTokenPicker({ accountName, activeRichTokenIndex, availableRichTokens, failedAddedRichToken, handleRichTokenSearchKeyDown, hideRichTokenSelection, highlightedRichTokenIndex, matchingAvailableRichTokens, recentRichTokenKeys, richTokenError, richTokenFilter, richTokenPending, richTokenPendingKey, richTokenResultsScrollTop, richTokenSearch, selectedAvailableRichTokens, selectedRichTokenKeys, toggleRichTokenSelection }: RichModeTokenPickerProps) {
	const selectFilter = (filter: RichTokenFilter) => {
		richTokenFilter.value = filter
		highlightedRichTokenIndex.value = 0
	}
	return <section class = 'rich-mode-token-view' role = 'region' aria-label = { `Select tokens for ${ accountName }` }>
		<header class = 'rich-mode-token-view-navigation'>
			<button type = 'button' class = 'btn btn--ghost rich-mode-modal-back' aria-label = 'Back to balances' disabled = { richTokenPending.value } onClick = { hideRichTokenSelection }>‹</button>
			<div class = 'rich-mode-token-view-heading'>
				<nav aria-label = 'Rich balance navigation'><span>Balances</span><span aria-hidden = 'true'>/</span><strong>Select tokens</strong></nav>
				<span class = 'rich-mode-count-badge'>{ availableRichTokens.value.length.toString() } available</span>
			</div>
		</header>
		<div class = 'rich-mode-token-view-content'>
			<div class = 'field rich-mode-token-search'>
				<div class = 'control'>
					<input
						class = 'input'
						type = 'search'
						autoFocus = { true }
						aria-activedescendant = { matchingAvailableRichTokens.value.length === 0 ? undefined : `rich-token-option-${ activeRichTokenIndex.value.toString() }` }
						aria-autocomplete = 'list'
						aria-controls = 'rich-token-search-results'
						aria-expanded = 'true'
						aria-label = 'Search address-book tokens'
						placeholder = { `Search ${ availableRichTokens.value.length.toString() } address-book token${ availableRichTokens.value.length === 1 ? '' : 's' }…` }
						disabled = { richTokenPending.value }
						role = 'combobox'
						value = { richTokenSearch.value }
						onInput = { event => { richTokenSearch.value = event.currentTarget.value; highlightedRichTokenIndex.value = 0 } }
						onKeyDown = { handleRichTokenSearchKeyDown }
					/>
				</div>
			</div>
			<div class = 'rich-mode-token-filters' aria-label = 'Filter address-book tokens' role = 'group'>
				<button type = 'button' disabled = { richTokenPending.value } aria-pressed = { richTokenFilter.value === 'All' } onClick = { () => { selectFilter('All') } }>All</button>
				<button type = 'button' disabled = { richTokenPending.value } aria-pressed = { richTokenFilter.value === 'ERC20' } onClick = { () => { selectFilter('ERC20') } }>ERC20</button>
				<button type = 'button' disabled = { richTokenPending.value } aria-pressed = { richTokenFilter.value === 'ERC1155' } onClick = { () => { selectFilter('ERC1155') } }>ERC1155</button>
			</div>
			{ selectedAvailableRichTokens.value.length === 0 ? <></> : <div class = 'rich-mode-selected-token-bar'><div class = 'rich-mode-selected-token-chips' aria-label = 'Selected tokens'>
				{ selectedAvailableRichTokens.value.map((option) => <button type = 'button' class = { `rich-mode-selected-token-chip${ richTokenPendingKey.value === getRichTokenIdentityKey(option) ? ' is-pending' : '' }` } aria-label = { `Remove ${ getRichTokenLabel(option) } from selection` } disabled = { richTokenPending.value } onClick = { () => { toggleRichTokenSelection(option) } } key = { getRichTokenIdentityKey(option) }>
					<RichTokenIcon class = 'rich-mode-selected-token-chip-icon' label = { option.symbol } logoUri = { option.logoUri }/>
					<span>{ getRichTokenLabel(option) }</span><span aria-hidden = 'true'>{ richTokenPendingKey.value === getRichTokenIdentityKey(option) ? '…' : '×' }</span>
				</button>) }
			</div><button type = 'button' class = 'btn btn--ghost is-small rich-mode-clear-token-selection' disabled = { richTokenPending.value } onClick = { () => { selectedRichTokenKeys.value = [] } }>Clear</button>
			</div> }
			<div
				id = 'rich-token-search-results'
				aria-label = 'Matching address-book tokens'
				aria-multiselectable = 'true'
				class = 'rich-mode-token-results'
				role = 'listbox'
				ref = { element => { if (element !== null) element.scrollTop = richTokenResultsScrollTop.peek() } }
				onScroll = { event => { richTokenResultsScrollTop.value = event.currentTarget.scrollTop } }
			>
				{ matchingAvailableRichTokens.value.map((option, index) => {
					const selected = selectedRichTokenKeys.value.includes(getRichTokenIdentityKey(option))
					const recent = recentRichTokenKeys.value.includes(getRichTokenIdentityKey(option))
					return <button
						type = 'button'
						id = { `rich-token-option-${ index.toString() }` }
						data-rich-token-result = { getRichTokenIdentityKey(option) }
						class = { `btn btn--ghost rich-mode-token-result${ selected ? ' is-selected' : '' }${ activeRichTokenIndex.value === index ? ' is-highlighted' : '' }` }
						disabled = { richTokenPending.value }
						aria-label = { `Select rich token ${ getRichTokenLabel(option) } ${ addressString(option.tokenAddress) }` }
						aria-selected = { selected }
						role = 'option'
						onClick = { () => { toggleRichTokenSelection(option) } }
						onMouseEnter = { () => { highlightedRichTokenIndex.value = index } }
						key = { getRichTokenIdentityKey(option) }
					>
						<RichTokenIcon class = 'rich-mode-token-result-icon' label = { option.symbol } logoUri = { option.logoUri }/>
						<span class = 'rich-mode-token-result-details'>
							<strong><HighlightedRichTokenText query = { richTokenSearch.value } text = { getRichTokenLabel(option) }/></strong>
							<span class = 'rich-mode-token-result-meta'><span><HighlightedRichTokenText query = { richTokenSearch.value } text = { option.name }/></span><em>{ recent && richTokenSearch.value.trim() === '' ? `Recent · ${ option.tokenType }` : option.tokenType }</em></span>
							<small><HighlightedRichTokenText query = { richTokenSearch.value } text = { addressString(option.tokenAddress) }/></small>
						</span>
						<span class = 'rich-mode-token-selection-mark' aria-hidden = 'true'>{ selected ? '✓' : '' }</span>
					</button>
				}) }
				{ matchingAvailableRichTokens.value.length === 0 ? <div class = 'rich-mode-empty-state rich-mode-token-empty-state'><span class = 'rich-mode-empty-state-icon' aria-hidden = 'true'>⌕</span><span><strong>No matching tokens</strong><small>Try a symbol, name, or address.</small></span>{ richTokenSearch.value === '' ? <></> : <button type = 'button' class = 'btn btn--ghost is-small' onClick = { () => { richTokenSearch.value = '' } }>Clear</button> }</div> : <></> }
			</div>
			{ richTokenError.value === undefined || failedAddedRichToken.value === undefined ? <></> : <p class = 'help is-danger'>{ richTokenError.value }</p> }
		</div>
	</section>
}

// The footer actions of the token-selection view.
export function RichModeTokenPickerFooter({ addSelectedRichTokens, hideRichTokenSelection, richTokenPending, selectedAvailableRichTokens }: {
	addSelectedRichTokens: () => Promise<void>
	hideRichTokenSelection: () => void
	richTokenPending: Signal<boolean>
	selectedAvailableRichTokens: ReadonlySignal<readonly RichTokenOption[]>
}) {
	return <InterceptorDialogFooter class = 'rich-mode-token-view-footer'>
		<button type = 'button' class = 'btn btn--ghost' disabled = { richTokenPending.value } onClick = { hideRichTokenSelection }>Back</button>
		<span class = 'rich-mode-token-selection-count rich-mode-count-badge'>{ selectedAvailableRichTokens.value.length.toString() } selected</span>
		<button type = 'button' class = 'btn btn--primary' aria-label = 'Add selected tokens' disabled = { richTokenPending.value || selectedAvailableRichTokens.value.length === 0 } onClick = { () => { void addSelectedRichTokens() } }>Add { selectedAvailableRichTokens.value.length === 0 ? '' : selectedAvailableRichTokens.value.length.toString() } token{ selectedAvailableRichTokens.value.length === 1 ? '' : 's' }</button>
	</InterceptorDialogFooter>
}
