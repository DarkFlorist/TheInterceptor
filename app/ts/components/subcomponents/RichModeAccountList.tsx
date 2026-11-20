import { type ReadonlySignal, type Signal, useComputed, useSignal } from '@preact/signals'
import type { AddressBookEntry } from '../../types/addressBookTypes.js'
import type { EnrichedRichListElement } from '../../types/interceptor-reply-messages.js'
import type { RichAccountBalance, RichTokenOption } from '../../types/richMode.js'
import type { RenameAddressCallBack } from '../../types/user-interface-types.js'
import { addressString } from '../../utils/bigint.js'
import { truncateAddr } from '../../utils/ethereum.js'
import type { AsyncActionContext } from '../../utils/preact-utilities.js'
import { getRichTokenIdentityKey } from '../../utils/richTokens.js'
import { AddressIcon, SmallAddress } from './address.js'
import { AsyncStatusIcon } from './AsyncAction.js'
import { ErrorComponent } from './Error.js'
import { ChevronIcon, SearchIcon } from './icons.js'
import { findFundedRichTokenOption, formatRichAmountForDisplay } from './RichModeShared.js'

function RichBalanceSummary({ profile, tokenOptions, nativeCurrencyTicker }: {
	profile: RichAccountBalance | undefined
	tokenOptions: readonly RichTokenOption[]
	nativeCurrencyTicker: string
}) {
	if (profile === undefined) return <></>
	const tokenItems = profile.tokenBalances.flatMap((balance) => {
		const option = findFundedRichTokenOption(tokenOptions, balance)
		return option === undefined ? [] : [{
			amount: formatRichAmountForDisplay(balance.amount, Number(option.decimals)),
			key: getRichTokenIdentityKey(option),
			label: option.tokenId === undefined ? option.symbol : `${ option.symbol } #${ option.tokenId.toString() }`,
			logoUri: option.logoUri,
		}]
	})
	const items = [{ amount: formatRichAmountForDisplay(profile.nativeAmount, 18), key: 'native', label: nativeCurrencyTicker, logoUri: nativeCurrencyTicker === 'ETH' ? '../img/coins/ethereum.png' : undefined }, ...tokenItems]
	const visibleItems = items.slice(0, 3)
	return <span class = 'rich-mode-balance-summary' aria-hidden = 'true'>
		{ visibleItems.map((item) => <span class = { `rich-mode-balance-summary-item${ item.key === 'native' ? ' is-native' : '' }` } title = { `${ item.label }: ${ item.amount }` } key = { item.key }>
			{ item.logoUri === undefined
				? <span class = 'rich-mode-balance-summary-monogram' aria-hidden = 'true'>{ item.label.slice(0, 2) }</span>
				: <img class = 'rich-mode-balance-summary-icon' src = { item.logoUri } width = '14' height = '14' aria-hidden = 'true'/>
			}
			<small>{ item.amount } { item.label }</small>
		</span>) }
		{ items.length <= visibleItems.length ? <></> : <span class = 'rich-mode-balance-summary-overflow'>+{ (items.length - visibleItems.length).toString() }</span> }
	</span>
}

type RichModeAccountListProps = {
	activeAddress: Signal<AddressBookEntry | undefined>
	chainId: bigint
	controlsDisabled: boolean
	enableMakeCurrentAddressRich: (enabled: boolean) => void
	isInitialHomeDataLoaded: Signal<boolean>
	makeCurrentAddressRich: ReadonlySignal<boolean>
	modifyRichList: (addressBookEntry: AddressBookEntry, makeRich: boolean) => void
	nativeCurrencyTicker: string
	openBalances: (address: bigint) => void
	renameAddressCallBack: RenameAddressCallBack
	richAccountBalances: ReadonlySignal<readonly RichAccountBalance[]>
	richAccounts: ReadonlySignal<readonly EnrichedRichListElement[]>
	richAssetCount: ReadonlySignal<number>
	richChangeState: AsyncActionContext<void>['value']
	richList: ReadonlySignal<readonly EnrichedRichListElement[]>
	richTokenOptions: ReadonlySignal<readonly RichTokenOption[]>
	visibleRichList: ReadonlySignal<readonly EnrichedRichListElement[]>
}

// The card header, its collapsed current-account shortcut and the expandable list of accounts that can be made rich.
export function RichModeAccountList({ activeAddress, chainId, controlsDisabled, enableMakeCurrentAddressRich, isInitialHomeDataLoaded, makeCurrentAddressRich, modifyRichList, nativeCurrencyTicker, openBalances, renameAddressCallBack, richAccountBalances, richAccounts, richAssetCount, richChangeState, richList, richTokenOptions, visibleRichList }: RichModeAccountListProps) {
	const showList = useSignal<boolean>(false)
	const richAccountSearch = useSignal('')
	const activeAddressSetAsRichViaFixedAddressList = useComputed(() =>
		richList.value.filter((element) => element.makingRich).some((element) => element.addressBookEntry.address === activeAddress.value?.address)
	)
	const filteredVisibleRichList = useComputed(() => {
		const query = richAccountSearch.value.trim().toLowerCase()
		if (query === '') return visibleRichList.value
		return visibleRichList.value.filter((element) => element.addressBookEntry.name.toLowerCase().includes(query) || addressString(element.addressBookEntry.address).toLowerCase().includes(query))
	})
	const filteredCurrentRichList = useComputed(() => filteredVisibleRichList.value.filter((element) => element.addressBookEntry.address === activeAddress.value?.address))
	const filteredOtherRichList = useComputed(() => filteredVisibleRichList.value.filter((element) => element.addressBookEntry.address !== activeAddress.value?.address))

	const renderRichAccountRow = (richListElement: EnrichedRichListElement) => {
		const accountIsRich = richAccounts.value.some((account) => account.addressBookEntry.address === richListElement.addressBookEntry.address)
		const accountProfile = richAccountBalances.value.find((profile) => profile.chainId === chainId && profile.address === richListElement.addressBookEntry.address)
		const isCurrentAddressRow = richListElement.type === 'CurrentActiveAddress'
		const isActiveAddressRow = richListElement.addressBookEntry.address === activeAddress.value?.address
		const configuredAssetCount = accountProfile === undefined ? 0 : accountProfile.tokenBalances.length + 1
		const accountAddress = addressString(richListElement.addressBookEntry.address)
		const accountAddressDescriptionId = `rich-account-address-${ accountAddress.slice(2) }`
		return <div class = { `rich-mode-account-row${ accountIsRich ? ' is-rich' : '' }${ isActiveAddressRow ? ' is-active-account' : '' }` } key = { richListElement.addressBookEntry.address.toString() }>
			<input class = 'rich-mode-account-toggle' type = 'checkbox' disabled = { controlsDisabled } checked = { isCurrentAddressRow ? makeCurrentAddressRich.value : richListElement.makingRich } aria-label = { `Toggle rich mode for ${ richListElement.addressBookEntry.name } (${ accountAddress })` } onInput = { event => { if (event.target instanceof HTMLInputElement && event.target !== null) { isCurrentAddressRow ? enableMakeCurrentAddressRich(event.target.checked) : modifyRichList(richListElement.addressBookEntry, event.target.checked) } } } />
			<button type = 'button' class = 'rich-mode-account-open' disabled = { !accountIsRich } aria-label = { `Edit balances for ${ richListElement.addressBookEntry.name }` } aria-describedby = { accountAddressDescriptionId } data-configured-assets = { configuredAssetCount.toString() } onClick = { () => { openBalances(richListElement.addressBookEntry.address) } }>
				<AddressIcon address = { richListElement.addressBookEntry.address } logoUri = { 'logoUri' in richListElement.addressBookEntry ? richListElement.addressBookEntry.logoUri : undefined } isBig = { false } backgroundColor = 'var(--surface-dark-color)'/>
				<span class = 'rich-mode-account-details'>
					<span class = 'rich-mode-account-name-line'><strong>{ richListElement.addressBookEntry.name }</strong>{ isActiveAddressRow ? <span class = 'rich-mode-current-account-badge'>Current</span> : <></> }</span>
					<span class = 'rich-mode-account-secondary'>
						{ !accountIsRich ? <small>Enable to configure balances</small> : <RichBalanceSummary profile = { accountProfile } tokenOptions = { richTokenOptions.value } nativeCurrencyTicker = { nativeCurrencyTicker }/> }
						<small class = 'rich-mode-account-address' id = { accountAddressDescriptionId } aria-label = { accountAddress } title = { accountAddress }>{ truncateAddr(accountAddress, 4) }</small>
					</span>
				</span>
				<span class = 'rich-mode-balance-action' aria-hidden = 'true'>›</span>
			</button>
		</div>
	}

	return <>
		<header class = 'card-header rich-mode-card-header'>
			<p class = 'card-header-title' style = 'font-weight: unset; font-size: 0.8em; padding: 0 0.5rem;'>
				<label class = 'form-control' style = 'grid-template-columns: 1em min-content; width: min-content;' onClick = { event => { event.stopPropagation() } }>
					<input type = 'checkbox' disabled = { controlsDisabled } checked = { makeCurrentAddressRich.value } onInput = { e => { if (e.target instanceof HTMLInputElement && e.target !== null) { enableMakeCurrentAddressRich(e.target.checked) } } } onClick = { event => { event.stopPropagation() } } />
					<p class = 'paragraph checkbox-text' style = 'white-space: nowrap;'> Make current account rich</p>
				</label>
			</p>
			<button type = 'button' class = 'card-header-icon noselect rich-mode-card-header-summary' aria-controls = 'rich-mode-account-manager' aria-expanded = { showList.value } aria-label = { showList.value ? 'Hide rich accounts' : 'Show rich accounts' } onClick = { () => { showList.value = !showList.value } }>
				<span>{ richAccounts.value.length.toString() } account{ richAccounts.value.length === 1 ? '' : 's' } · { richAssetCount.value.toString() } asset{ richAssetCount.value === 1 ? '' : 's' }</span>
				<span class = 'icon'><ChevronIcon /></span>
			</button>
		</header>
		{ richChangeState.value.state === 'pending' ? <div class = 'card-content-header' role = 'status' aria-live = 'polite'><AsyncStatusIcon state = 'pending'/> Updating balances...</div> : <></> }
		{ richChangeState.value.state === 'rejected' ? <ErrorComponent text = { richChangeState.value.error.message }/> : <></> }
		{ !showList.value
			? <> { !activeAddressSetAsRichViaFixedAddressList.value || activeAddress.value === undefined ? <></> : <>
				<div class = 'card-content-header' style = 'font-size: 0.8em;'>
					<label class = 'form-control' style = 'gap: 1em;'>
						<input type = 'checkbox' disabled = { controlsDisabled } checked = { true } onInput = { e => { if (e.target instanceof HTMLInputElement && e.target !== null && activeAddress.value !== undefined) { modifyRichList(activeAddress.value, e.target.checked) } } } />
						<SmallAddress addressBookEntry = { activeAddress } renameAddressCallBack = { renameAddressCallBack } noCopying = { !isInitialHomeDataLoaded.value } noEditAddress = { !isInitialHomeDataLoaded.value } />
					</label>
				</div>
			</> } </>
			: <div id = 'rich-mode-account-manager' class = 'card-content rich-mode-account-manager'>
				<div class = 'rich-mode-account-list-head'>
					<div><strong>Accounts</strong><small>{ richAccounts.value.length.toString() } enabled · { richAssetCount.value.toString() } asset{ richAssetCount.value === 1 ? '' : 's' }</small></div>
					{ visibleRichList.value.length <= 6 ? <></> : <label class = 'rich-mode-account-search'>
						<span aria-hidden = 'true'><SearchIcon/></span>
						<input type = 'search' aria-label = 'Search rich accounts' placeholder = 'Search accounts…' value = { richAccountSearch.value } onInput = { event => { richAccountSearch.value = event.currentTarget.value } } />
					</label> }
				</div>
				<div>
					<div aria-label = 'Rich accounts' class = 'rich-mode-account-list'>
						{ filteredCurrentRichList.value.length === 0 ? <></> : <section class = 'rich-mode-account-group' aria-label = 'Current account'><p class = 'rich-mode-account-group-label'>Current account</p>{ filteredCurrentRichList.value.map(renderRichAccountRow) }</section> }
						{ filteredOtherRichList.value.length === 0 ? <></> : <section class = 'rich-mode-account-group' aria-label = 'Other rich accounts'><p class = 'rich-mode-account-group-label'>Other accounts</p>{ filteredOtherRichList.value.map(renderRichAccountRow) }</section> }
						{ filteredVisibleRichList.value.length !== 0 ? <></> : <div class = 'rich-mode-account-empty'><strong>No matching accounts</strong><button type = 'button' class = 'btn btn--ghost is-small' onClick = { () => { richAccountSearch.value = '' } }>Clear search</button></div> }
					</div>
				</div>
			</div>
		}
	</>
}
