import type { RichModeTokenController } from '../hooks/useRichModeTokens.js'
import { addressString } from '../../utils/bigint.js'
import { getRichTokenIdentityKey, getRichTokenLabel } from '../../utils/richTokens.js'
import { InterceptorDialogFooter } from './InterceptorDialog.js'
import { RichTokenIcon } from './RichModeShared.js'

function HighlightedRichTokenText({ query, text }: { query: string, text: string }) {
	const normalizedQuery = query.trim().toLowerCase()
	const matchIndex = normalizedQuery === '' ? -1 : text.toLowerCase().indexOf(normalizedQuery)
	if (matchIndex === -1) return <>{ text }</>
	return <>{ text.slice(0, matchIndex) }<mark>{ text.slice(matchIndex, matchIndex + normalizedQuery.length) }</mark>{ text.slice(matchIndex + normalizedQuery.length) }</>
}

// The token-selection view of the rich-account dialog: search and pick address-book tokens to fund for one account.
export function RichModeTokenPicker({ model, feedback, accountName }: { model: RichModeTokenController['picker'], feedback: RichModeTokenController['feedback'], accountName: string }) {
	const { activeRichTokenIndex, availableRichTokens, failedAddedRichToken, matchingAvailableRichTokens, recentRichTokenKeys, richTokenFilter, richTokenResultsScrollTop, richTokenSearch, selectedAvailableRichTokens, selectedRichTokenKeys } = model.data.value
	const { handleRichTokenSearchKeyDown, hideRichTokenSelection, toggleRichTokenSelection, setSearch, selectFilter, clearSelection, scrollResults, highlightToken } = model.actions
	const { richTokenPending, richTokenPendingKey, richTokenError } = feedback.value
	return <section class = 'rich-mode-token-view' role = 'region' aria-label = { `Select tokens for ${ accountName }` }>
		<header class = 'rich-mode-token-view-navigation'>
			<button type = 'button' class = 'btn btn--ghost rich-mode-modal-back' aria-label = 'Back to balances' disabled = { richTokenPending } onClick = { hideRichTokenSelection }>‹</button>
			<div class = 'rich-mode-token-view-heading'>
				<nav aria-label = 'Rich balance navigation'><span>Balances</span><span aria-hidden = 'true'>/</span><strong>Select tokens</strong></nav>
				<span class = 'rich-mode-count-badge'>{ availableRichTokens.length.toString() } available</span>
			</div>
		</header>
		<div class = 'rich-mode-token-view-content'>
			<div class = 'field rich-mode-token-search'>
				<div class = 'control'>
					<input
						class = 'input'
						type = 'search'
						autoFocus = { true }
						aria-activedescendant = { matchingAvailableRichTokens.length === 0 ? undefined : `rich-token-option-${ activeRichTokenIndex.toString() }` }
						aria-autocomplete = 'list'
						aria-controls = 'rich-token-search-results'
						aria-expanded = 'true'
						aria-label = 'Search address-book tokens'
						placeholder = { `Search ${ availableRichTokens.length.toString() } address-book token${ availableRichTokens.length === 1 ? '' : 's' }…` }
						disabled = { richTokenPending }
						role = 'combobox'
						value = { richTokenSearch }
						onInput = { event => { setSearch(event.currentTarget.value) } }
						onKeyDown = { handleRichTokenSearchKeyDown }
					/>
				</div>
			</div>
			<div class = 'rich-mode-token-filters' aria-label = 'Filter address-book tokens' role = 'group'>
				<button type = 'button' disabled = { richTokenPending } aria-pressed = { richTokenFilter === 'All' } onClick = { () => { selectFilter('All') } }>All</button>
				<button type = 'button' disabled = { richTokenPending } aria-pressed = { richTokenFilter === 'ERC20' } onClick = { () => { selectFilter('ERC20') } }>ERC20</button>
				<button type = 'button' disabled = { richTokenPending } aria-pressed = { richTokenFilter === 'ERC1155' } onClick = { () => { selectFilter('ERC1155') } }>ERC1155</button>
			</div>
			{ selectedAvailableRichTokens.length === 0 ? <></> : <div class = 'rich-mode-selected-token-bar'><div class = 'rich-mode-selected-token-chips' aria-label = 'Selected tokens'>
				{ selectedAvailableRichTokens.map((option) => <button type = 'button' class = { `rich-mode-selected-token-chip${ richTokenPendingKey === getRichTokenIdentityKey(option) ? ' is-pending' : '' }` } aria-label = { `Remove ${ getRichTokenLabel(option) } from selection` } disabled = { richTokenPending } onClick = { () => { toggleRichTokenSelection(option) } } key = { getRichTokenIdentityKey(option) }>
					<RichTokenIcon class = 'rich-mode-selected-token-chip-icon' label = { option.symbol } logoUri = { option.logoUri }/>
					<span>{ getRichTokenLabel(option) }</span><span aria-hidden = 'true'>{ richTokenPendingKey === getRichTokenIdentityKey(option) ? '…' : '×' }</span>
				</button>) }
			</div><button type = 'button' class = 'btn btn--ghost is-small rich-mode-clear-token-selection' disabled = { richTokenPending } onClick = { () => { clearSelection() } }>Clear</button>
			</div> }
			<div
				id = 'rich-token-search-results'
				aria-label = 'Matching address-book tokens'
				aria-multiselectable = 'true'
				class = 'rich-mode-token-results'
				role = 'listbox'
				ref = { element => { if (element !== null) element.scrollTop = richTokenResultsScrollTop } }
				onScroll = { event => { scrollResults(event.currentTarget.scrollTop) } }
			>
				{ matchingAvailableRichTokens.map((option, index) => {
					const selected = selectedRichTokenKeys.includes(getRichTokenIdentityKey(option))
					const recent = recentRichTokenKeys.includes(getRichTokenIdentityKey(option))
					return <button
						type = 'button'
						id = { `rich-token-option-${ index.toString() }` }
						data-rich-token-result = { getRichTokenIdentityKey(option) }
						class = { `btn btn--ghost rich-mode-token-result${ selected ? ' is-selected' : '' }${ activeRichTokenIndex === index ? ' is-highlighted' : '' }` }
						disabled = { richTokenPending }
						aria-label = { `Select rich token ${ getRichTokenLabel(option) } ${ addressString(option.tokenAddress) }` }
						aria-selected = { selected }
						role = 'option'
						onClick = { () => { toggleRichTokenSelection(option) } }
						onMouseEnter = { () => { highlightToken(index) } }
						key = { getRichTokenIdentityKey(option) }
					>
						<RichTokenIcon class = 'rich-mode-token-result-icon' label = { option.symbol } logoUri = { option.logoUri }/>
						<span class = 'rich-mode-token-result-details'>
							<strong><HighlightedRichTokenText query = { richTokenSearch } text = { getRichTokenLabel(option) }/></strong>
							<span class = 'rich-mode-token-result-meta'><span><HighlightedRichTokenText query = { richTokenSearch } text = { option.name }/></span><em>{ recent && richTokenSearch.trim() === '' ? `Recent · ${ option.tokenType }` : option.tokenType }</em></span>
							<small><HighlightedRichTokenText query = { richTokenSearch } text = { addressString(option.tokenAddress) }/></small>
						</span>
						<span class = 'rich-mode-token-selection-mark' aria-hidden = 'true'>{ selected ? '✓' : '' }</span>
					</button>
				}) }
				{ matchingAvailableRichTokens.length === 0 ? <div class = 'rich-mode-empty-state rich-mode-token-empty-state'><span class = 'rich-mode-empty-state-icon' aria-hidden = 'true'>⌕</span><span><strong>No matching tokens</strong><small>Try a symbol, name, or address.</small></span>{ richTokenSearch === '' ? <></> : <button type = 'button' class = 'btn btn--ghost is-small' onClick = { () => { setSearch('') } }>Clear</button> }</div> : <></> }
			</div>
			{ richTokenError === undefined || failedAddedRichToken === undefined ? <></> : <p class = 'help is-danger'>{ richTokenError }</p> }
		</div>
	</section>
}

// The footer actions of the token-selection view.
export function RichModeTokenPickerFooter({ model, feedback }: { model: RichModeTokenController['picker'], feedback: RichModeTokenController['feedback'] }) {
	const { addSelectedRichTokens, hideRichTokenSelection } = model.actions
	const { selectedAvailableRichTokens } = model.data.value
	const { richTokenPending } = feedback.value
	return <InterceptorDialogFooter class = 'rich-mode-token-view-footer'>
		<button type = 'button' class = 'btn btn--ghost' disabled = { richTokenPending } onClick = { hideRichTokenSelection }>Back</button>
		<span class = 'rich-mode-token-selection-count rich-mode-count-badge'>{ selectedAvailableRichTokens.length.toString() } selected</span>
		<button type = 'button' class = 'btn btn--primary' aria-label = 'Add selected tokens' disabled = { richTokenPending || selectedAvailableRichTokens.length === 0 } onClick = { () => { void addSelectedRichTokens() } }>Add { selectedAvailableRichTokens.length === 0 ? '' : selectedAvailableRichTokens.length.toString() } token{ selectedAvailableRichTokens.length === 1 ? '' : 's' }</button>
	</InterceptorDialogFooter>
}
