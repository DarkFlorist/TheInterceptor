import { type Signal, useComputed, useSignal, useSignalEffect } from '@preact/signals'
import type { ComponentChildren, JSX } from 'preact'
import { useId, useRef } from 'preact/hooks'
import { sendPopupMessageToBackgroundPage, sendPopupMessageWithReply } from '../../background/backgroundUtils.js'
import type { AddressBookEntry } from '../../types/addressBookTypes.js'
import type { EnrichedRichListElement } from '../../types/interceptor-reply-messages.js'
import type { RichAccountBalance, RichTokenOption } from '../../types/richMode.js'
import type { RenameAddressCallBack } from '../../types/user-interface-types.js'
import { addressString } from '../../utils/bigint.js'
import { truncateAddr } from '../../utils/ethereum.js'
import { formatUnits } from '../../utils/ethereumUnits.js'
import { getDefaultRichTokenAmount, getMatchingRichTokenOptions, getRichTokenIdentityKey, getRichTokenLabel, parseRichTokenAmountInput, sameRichTokenIdentity } from '../../utils/richTokens.js'
import { updateRichListAddress } from '../../utils/richList.js'
import { assertNever } from '../../utils/typescript.js'
import { AddressIcon, SmallAddress } from '../subcomponents/address.js'
import { InterceptorDialogBody, InterceptorDialogFooter, InterceptorDialogHeader, InterceptorDialogSurface } from '../subcomponents/InterceptorDialog.js'
import { ChevronIcon, SearchIcon, TrashIcon } from '../subcomponents/icons.js'

type RichModeAccountManagerProps = {
	makeCurrentAddressRich: Signal<boolean>
	richNativeAmount: Signal<bigint>
	nativeCurrencyTicker: string
	activeAddress: Signal<AddressBookEntry | undefined>
	richList: Signal<readonly EnrichedRichListElement[]>
	richTokenOptions: Signal<readonly RichTokenOption[]>
	richAccountBalances: Signal<readonly RichAccountBalance[]>
	chainId: bigint
	renameAddressCallBack: RenameAddressCallBack
	isInitialHomeDataLoaded: Signal<boolean>
}

function RichTokenIcon({ label, logoUri, class: className }: { label: string, logoUri: string | undefined, class: string }) {
	return logoUri === undefined
		? <span class = { `${ className } rich-mode-token-monogram` } aria-hidden = 'true'>{ label.slice(0, 2) }</span>
		: <img class = { className } src = { logoUri } width = '20' height = '20' aria-hidden = 'true'/>
}

function RichBalanceRow({ action, balance, class: className, label, logoUri, name }: {
	action?: ComponentChildren
	balance: ComponentChildren
	class?: string
	label: string
	logoUri: string | undefined
	name: string
}) {
	return <div class = { `rich-mode-balance-row${ className === undefined ? '' : ` ${ className }` }` }>
		<RichTokenIcon class = 'rich-mode-balance-token-icon' label = { label } logoUri = { logoUri }/>
		<span class = 'rich-mode-balance-token-name'><strong>{ label }</strong><small>{ name }</small></span>
		{ balance }
		{ action ?? <span/> }
	</div>
}

function formatRichAmountForDisplay(amount: bigint, decimals: number) {
	const [integer = '0', fraction] = formatUnits(amount, decimals).split('.')
	const groupedInteger = integer.replace(/\B(?=(\d{3})+(?!\d))/gu, ',')
	return fraction === undefined ? groupedInteger : `${ groupedInteger }.${ fraction }`
}

function RichAmountEditor({ amount, autoFocus = false, defaultAmount, decimals, disabled, error, label, onCommit, onReset, unit }: {
	amount: bigint
	autoFocus?: boolean
	defaultAmount: bigint
	decimals: number
	disabled: boolean
	error: string | undefined
	label: string
	onCommit: (input: HTMLInputElement) => void
	onReset: () => void
	unit: string
}) {
	const focused = useSignal(false)
	const errorId = useId()
	const rawValue = formatUnits(amount, decimals)
	return <div class = 'rich-mode-amount-cell'>
		<div class = 'rich-mode-amount-with-unit'>
			<input
				autoFocus = { autoFocus }
				class = 'input is-small'
				aria-describedby = { error === undefined ? undefined : errorId }
				aria-invalid = { error === undefined ? undefined : 'true' }
				aria-label = { label }
				disabled = { disabled }
				value = { focused.value ? rawValue : formatRichAmountForDisplay(amount, decimals) }
				onFocus = { event => {
					focused.value = true
					const input = event.currentTarget
					globalThis.queueMicrotask(() => { if (typeof input.select === 'function') input.select() })
				} }
				onBlur = { () => { focused.value = false } }
				onChange = { event => { onCommit(event.currentTarget) } }
			/>
			<span class = 'rich-mode-amount-unit' aria-hidden = 'true'>{ unit }</span>
			<button type = 'button' class = 'rich-mode-reset-amount' aria-label = { `Reset ${ unit } rich amount to ${ formatRichAmountForDisplay(defaultAmount, decimals) }` } data-tooltip = 'Reset to default' disabled = { disabled || amount === defaultAmount } onClick = { onReset }>↺</button>
		</div>
		{ error === undefined ? <></> : <small id = { errorId } class = 'rich-mode-amount-error' role = 'alert'>{ error }</small> }
	</div>
}

function HighlightedRichTokenText({ query, text }: { query: string, text: string }) {
	const normalizedQuery = query.trim().toLowerCase()
	const matchIndex = normalizedQuery === '' ? -1 : text.toLowerCase().indexOf(normalizedQuery)
	if (matchIndex === -1) return <>{ text }</>
	return <>{ text.slice(0, matchIndex) }<mark>{ text.slice(matchIndex, matchIndex + normalizedQuery.length) }</mark>{ text.slice(matchIndex + normalizedQuery.length) }</>
}

function RichBalanceSummary({ profile, tokenOptions, nativeCurrencyTicker }: {
	profile: RichAccountBalance | undefined
	tokenOptions: readonly RichTokenOption[]
	nativeCurrencyTicker: string
}) {
	if (profile === undefined) return <></>
	const tokenItems = profile.tokenBalances.flatMap((balance) => {
		const option = tokenOptions.find((candidate) => sameRichTokenIdentity(candidate, balance))
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

export function RichModeAccountManager({ makeCurrentAddressRich, richNativeAmount, nativeCurrencyTicker, activeAddress, richList, richTokenOptions, richAccountBalances, chainId, renameAddressCallBack, isInitialHomeDataLoaded }: RichModeAccountManagerProps) {
	const selectRichTokensButtonRef = useRef<HTMLButtonElement>(null)
	async function enableMakeCurrentAddressRich(enabled: boolean) {
		if (!isInitialHomeDataLoaded.value) return
		sendPopupMessageToBackgroundPage( { method: 'popup_modifyMakeMeRich', data: { add: enabled, address: 'CurrentAddress'} } )
		makeCurrentAddressRich.value = enabled
		const address = activeAddress.value?.address
		if (enabled && address !== undefined && !richAccountBalances.value.some((profile) => profile.chainId === chainId && profile.address === address)) {
			richAccountBalances.value = [...richAccountBalances.value, { chainId, address, nativeAmount: richNativeAmount.value, tokenBalances: [] }]
		}
	}
	async function modifyRichList(addressBookEntry: AddressBookEntry, makeRich: boolean) {
		if (!isInitialHomeDataLoaded.value) return
		richList.value = updateRichListAddress(
			richList.value,
			addressBookEntry.address,
			makeRich,
			(element) => element.addressBookEntry.address,
			() => ({ addressBookEntry, makingRich: true, type: 'UserAdded' as const }),
		)
		if (makeRich && !richAccountBalances.value.some((profile) => profile.chainId === chainId && profile.address === addressBookEntry.address)) {
			richAccountBalances.value = [...richAccountBalances.value, { chainId, address: addressBookEntry.address, nativeAmount: richNativeAmount.value, tokenBalances: [] }]
		}
		sendPopupMessageToBackgroundPage( { method: 'popup_modifyMakeMeRich', data: { add: makeRich, address: addressBookEntry.address } } )
	}

	const showList = useSignal<boolean>(false)
	const richAccountSearch = useSignal('')
	const richTokenError = useSignal<string | undefined>(undefined)
	const richTokenErrorTarget = useSignal<string | undefined>(undefined)
	const richTokenPending = useSignal(false)
	const richTokenPendingKey = useSignal<string | undefined>(undefined)
	const richTokenPendingLabel = useSignal<string | undefined>(undefined)
	const richTokenSaveConfirmedAddress = useSignal<bigint | undefined>(undefined)
	const richTokenSearch = useSignal('')
	const richTokenFilter = useSignal<'All' | 'ERC20' | 'ERC1155'>('All')
	const highlightedRichTokenIndex = useSignal(0)
	const richTokenResultsScrollTop = useSignal(0)
	const recentRichTokenKeys = useSignal<readonly string[]>([])
	const showRichBalanceDialog = useSignal(false)
	const showRichTokenPicker = useSignal(false)
	const selectedRichTokenKeys = useSignal<readonly string[]>([])
	const addingRichTokenKeys = useSignal<readonly string[]>([])
	const failedAddedRichTokenKey = useSignal<string | undefined>(undefined)
	const newlyAddedRichTokenKeys = useSignal<readonly string[]>([])
	const selectedRichAddress = useSignal<bigint | undefined>(undefined)
	const updateProfileForAddress = (address: bigint, update: (profile: RichAccountBalance) => RichAccountBalance) => {
		richAccountBalances.value = richAccountBalances.value.map((profile) => profile.chainId === chainId && profile.address === address ? update(profile) : profile)
	}
	useSignalEffect(() => {
		if (richTokenSaveConfirmedAddress.value === undefined) return
		const timeout = globalThis.setTimeout(() => { richTokenSaveConfirmedAddress.value = undefined }, 1600)
		return () => { globalThis.clearTimeout(timeout) }
	})
	useSignalEffect(() => {
		if (newlyAddedRichTokenKeys.value.length === 0) return
		const timeout = globalThis.setTimeout(() => { newlyAddedRichTokenKeys.value = [] }, 1800)
		return () => { globalThis.clearTimeout(timeout) }
	})
	const resetRichDialogViewState = () => {
		richTokenSearch.value = ''
		richTokenFilter.value = 'All'
		highlightedRichTokenIndex.value = 0
		richTokenResultsScrollTop.value = 0
		selectedRichTokenKeys.value = []
		addingRichTokenKeys.value = []
		failedAddedRichTokenKey.value = undefined
		newlyAddedRichTokenKeys.value = []
		richTokenError.value = undefined
		richTokenErrorTarget.value = undefined
	}
	const runRichOperation = async <Result,>(key: string, label: string, operation: () => Promise<Result>) => {
		richTokenPending.value = true
		richTokenPendingKey.value = key
		richTokenPendingLabel.value = label
		richTokenSaveConfirmedAddress.value = undefined
		richTokenError.value = undefined
		richTokenErrorTarget.value = undefined
		try {
			return await operation()
		} finally {
			richTokenPending.value = false
			richTokenPendingKey.value = undefined
			richTokenPendingLabel.value = undefined
		}
	}

	const setRichTokenEnabled = async (option: RichTokenOption, enabled: boolean, targetAddress?: bigint) => {
		const address = targetAddress ?? selectedRichAccount.value?.addressBookEntry.address
		if (richTokenPending.value || address === undefined) return false
		const tokenKey = getRichTokenIdentityKey(option)
		const reply = await runRichOperation(
			tokenKey,
			enabled ? `Preparing ${ getRichTokenLabel(option) }…` : `Removing ${ getRichTokenLabel(option) } from rich mode…`,
			async () => await sendPopupMessageWithReply({
				method: 'popup_modifyRichToken',
				data: { action: enabled ? 'Add' : 'Remove', address, tokenAddress: option.tokenAddress, tokenId: option.tokenId },
			}),
		)
		if (reply === undefined) {
			richTokenError.value = 'The background service did not return a token funding result.'
			richTokenErrorTarget.value = tokenKey
			return false
		}
		if (reply.result.success === false) {
			richTokenError.value = reply.result.error
			richTokenErrorTarget.value = tokenKey
			return false
		}
		const configuredRichToken = reply.result.richToken
		if (configuredRichToken !== undefined) {
			richTokenOptions.value = richTokenOptions.value.map((entry) => sameRichTokenIdentity(entry, option) ? { ...entry, ...configuredRichToken, enabled: true } : entry)
		}
		updateProfileForAddress(address, (profile) => enabled
			? profile.tokenBalances.some((balance) => sameRichTokenIdentity(balance, option))
				? profile
				: { ...profile, tokenBalances: [...profile.tokenBalances, { tokenAddress: option.tokenAddress, tokenId: option.tokenId, amount: configuredRichToken?.amount ?? option.amount }] }
			: { ...profile, tokenBalances: profile.tokenBalances.filter((balance) => !sameRichTokenIdentity(balance, option)) })
		if (enabled) recentRichTokenKeys.value = [tokenKey, ...recentRichTokenKeys.value.filter((key) => key !== tokenKey)].slice(0, 5)
		richTokenSaveConfirmedAddress.value = address
		return true
	}

	const addSelectedRichTokens = async () => {
		const address = selectedRichAccount.value?.addressBookEntry.address
		if (address === undefined || richTokenPending.value) return
		const options = availableRichTokens.value.filter((option) => selectedRichTokenKeys.value.includes(getRichTokenIdentityKey(option)))
		if (options.length === 0) return
		showRichTokenPicker.value = false
		addingRichTokenKeys.value = options.map(getRichTokenIdentityKey)
		failedAddedRichTokenKey.value = undefined
		const addedKeys: string[] = []
		for (const option of options) {
			const tokenKey = getRichTokenIdentityKey(option)
			if (!await setRichTokenEnabled(option, true, address)) {
				failedAddedRichTokenKey.value = tokenKey
				break
			}
			addedKeys.push(tokenKey)
			addingRichTokenKeys.value = addingRichTokenKeys.value.filter((key) => key !== tokenKey)
		}
		addingRichTokenKeys.value = []
		selectedRichTokenKeys.value = selectedRichTokenKeys.value.filter((key) => !addedKeys.includes(key))
		if (addedKeys.length !== options.length) return
		newlyAddedRichTokenKeys.value = addedKeys
	}

	const saveNativeAmount = async (amount: bigint) => {
		const address = selectedRichAccount.value?.addressBookEntry.address
		const profile = selectedRichProfile.value
		if (address === undefined || profile === undefined || richTokenPending.value) return
		const previousAmount = profile.nativeAmount
		const reply = await runRichOperation('native', `Saving ${ nativeCurrencyTicker } amount…`, async () => {
			updateProfileForAddress(address, (current) => ({ ...current, nativeAmount: amount }))
			return await sendPopupMessageWithReply({ method: 'popup_modifyMakeMeRich', data: { nativeAmount: amount, address } })
		})
		if (reply?.result.success === true) {
			richTokenSaveConfirmedAddress.value = address
			return
		}
		updateProfileForAddress(address, (current) => ({ ...current, nativeAmount: previousAmount }))
		richTokenError.value = reply === undefined ? 'The background service did not confirm the native balance.' : reply.result.error
		richTokenErrorTarget.value = 'native'
	}

	const setNativeAmount = (input: HTMLInputElement) => {
		const profile = selectedRichProfile.value
		if (profile === undefined) return
		richTokenError.value = undefined
		richTokenErrorTarget.value = undefined
		const parsedAmount = parseRichTokenAmountInput(input.value, 18n)
		if (parsedAmount.valid === false) {
			richTokenError.value = parsedAmount.reason === 'ExceedsUint256'
				? `${ nativeCurrencyTicker } amount cannot exceed the maximum uint256 value.`
				: `Enter a positive ${ nativeCurrencyTicker } amount with at most 18 decimal places.`
			richTokenErrorTarget.value = 'native'
			input.value = formatUnits(profile.nativeAmount, 18)
			return
		}
		void saveNativeAmount(parsedAmount.amount)
	}

	const saveRichTokenAmount = async (option: RichTokenOption, amount: bigint) => {
		const address = selectedRichAccount.value?.addressBookEntry.address
		if (address === undefined) return
		if (richTokenPending.value) return
		const tokenKey = getRichTokenIdentityKey(option)
		const reply = await runRichOperation(tokenKey, `Saving ${ getRichTokenLabel(option) } amount…`, async () => await sendPopupMessageWithReply({ method: 'popup_modifyRichToken', data: { action: 'SetAmount', address, tokenAddress: option.tokenAddress, tokenId: option.tokenId, amount } }))
		if (reply === undefined) {
			richTokenError.value = 'The background service did not return a token funding result.'
			richTokenErrorTarget.value = tokenKey
			return
		}
		if (reply.result.success === false) {
			richTokenError.value = reply.result.error
			richTokenErrorTarget.value = tokenKey
			return
		}
		updateProfileForAddress(address, (profile) => ({ ...profile, tokenBalances: profile.tokenBalances.map((balance) => sameRichTokenIdentity(balance, option) ? { ...balance, amount } : balance) }))
		richTokenSaveConfirmedAddress.value = address
	}

	const setRichTokenAmount = async (option: RichTokenOption, input: HTMLInputElement) => {
		richTokenError.value = undefined
		richTokenErrorTarget.value = undefined
		const parsedAmount = parseRichTokenAmountInput(input.value, option.decimals)
		if (parsedAmount.valid === false) {
			richTokenError.value = parsedAmount.reason === 'ExceedsUint256'
				? 'Token amount cannot exceed the maximum uint256 value.'
				: `Enter a positive ${ option.symbol } amount with at most ${ option.decimals.toString() } decimal places.`
			richTokenErrorTarget.value = getRichTokenIdentityKey(option)
			input.value = formatUnits(option.amount, Number(option.decimals))
			return
		}
		await saveRichTokenAmount(option, parsedAmount.amount)
	}

	const activeAddressSetAsRichViaFixedAddressList = useComputed(() =>
		richList.value.filter((element) => element.makingRich).some((element) => element.addressBookEntry.address === activeAddress.value?.address)
	)
	const visibleRichList = useComputed(() => {
		const peekedActiveAddress = activeAddress.peek() // peek active address here to avoid double render (changing active address retriggers rich bit later)
		if (peekedActiveAddress === undefined) return richList.value
		if (richList.value.some((element) => element.addressBookEntry.address === peekedActiveAddress.address)) return richList.value
		return [...richList.value, { addressBookEntry: peekedActiveAddress, makingRich: false, type: 'CurrentActiveAddress' as const }]
	})
	const richAccounts = useComputed(() => {
		const fixed = visibleRichList.value.filter((element) => element.makingRich)
		const current = activeAddress.value
		if (!makeCurrentAddressRich.value || current === undefined || fixed.some((element) => element.addressBookEntry.address === current.address)) return fixed
		return [{ addressBookEntry: current, makingRich: true, type: 'CurrentActiveAddress' as const }, ...fixed]
	})
	const richAssetCount = useComputed(() => {
		if (richAccounts.value.length === 0) return 0
		const accountAddresses = new Set(richAccounts.value.map((account) => account.addressBookEntry.address))
		const tokenKeys = new Set(richAccountBalances.value
			.filter((profile) => profile.chainId === chainId && accountAddresses.has(profile.address))
			.flatMap((profile) => profile.tokenBalances.map(getRichTokenIdentityKey)))
		return tokenKeys.size + 1
	})
	const filteredVisibleRichList = useComputed(() => {
		const query = richAccountSearch.value.trim().toLowerCase()
		if (query === '') return visibleRichList.value
		return visibleRichList.value.filter((element) => element.addressBookEntry.name.toLowerCase().includes(query) || addressString(element.addressBookEntry.address).toLowerCase().includes(query))
	})
	const filteredCurrentRichList = useComputed(() => filteredVisibleRichList.value.filter((element) => element.addressBookEntry.address === activeAddress.value?.address))
	const filteredOtherRichList = useComputed(() => filteredVisibleRichList.value.filter((element) => element.addressBookEntry.address !== activeAddress.value?.address))
	const selectedRichAccount = useComputed(() => richAccounts.value.find((element) => element.addressBookEntry.address === selectedRichAddress.value))
	useSignalEffect(() => {
		const selectedAddress = selectedRichAddress.value
		if (selectedAddress === undefined || richAccounts.value.some((account) => account.addressBookEntry.address === selectedAddress)) return
		showRichBalanceDialog.value = false
		showRichTokenPicker.value = false
		resetRichDialogViewState()
		selectedRichAddress.value = undefined
	})
	const selectedRichProfile = useComputed(() => {
		const address = selectedRichAccount.value?.addressBookEntry.address
		return richAccountBalances.value.find((profile) => profile.chainId === chainId && profile.address === address)
	})
	const enabledRichTokens = useComputed(() => {
		const balances = selectedRichProfile.value?.tokenBalances ?? []
		return balances.flatMap((balance) => {
			const option = richTokenOptions.value.find((candidate) => sameRichTokenIdentity(candidate, balance))
			return option === undefined ? [] : [{ ...option, amount: balance.amount, enabled: true }]
		})
	})
	const availableRichTokens = useComputed(() => {
		const balances = selectedRichProfile.value?.tokenBalances ?? []
		return richTokenOptions.value.filter((option) => !balances.some((balance) => sameRichTokenIdentity(balance, option)))
	})
	const addingRichTokens = useComputed(() => availableRichTokens.value.filter((option) => addingRichTokenKeys.value.includes(getRichTokenIdentityKey(option))))
	const failedAddedRichToken = useComputed(() => availableRichTokens.value.find((option) => getRichTokenIdentityKey(option) === failedAddedRichTokenKey.value))
	const richBalanceAssetStatusLabel = useComputed(() => {
		if (addingRichTokens.value.length !== 0) return `${ addingRichTokens.value.length.toString() } adding`
		if (failedAddedRichToken.value !== undefined) return 'Needs attention'
		const assetCount = enabledRichTokens.value.length + 1
		return `${ assetCount.toString() } asset${ assetCount === 1 ? '' : 's' }`
	})
	const richOperationStatus = useComputed(() => {
		if (richTokenPending.value) return { className: 'is-saving', label: addingRichTokenKeys.value.length === 0 ? 'Saving…' : 'Scanning…' }
		if (richTokenError.value !== undefined) return { className: 'is-error', label: 'Needs attention' }
		if (richTokenSaveConfirmedAddress.value === selectedRichAddress.value) return { className: 'is-saved', label: '✓ Saved' }
		return undefined
	})
	const matchingAvailableRichTokens = useComputed(() => {
		const filteredByType = availableRichTokens.value.filter((option) => {
			switch (richTokenFilter.value) {
				case 'All': return true
				case 'ERC20': return option.tokenType === 'ERC20'
				case 'ERC1155': return option.tokenType === 'ERC1155'
				default: return assertNever(richTokenFilter.value)
			}
		})
		const candidates = richTokenSearch.value.trim() === ''
			? [...filteredByType].sort((first, second) => {
				const firstSelected = selectedRichTokenKeys.value.includes(getRichTokenIdentityKey(first))
				const secondSelected = selectedRichTokenKeys.value.includes(getRichTokenIdentityKey(second))
				if (firstSelected !== secondSelected) return firstSelected ? -1 : 1
				const firstIndex = recentRichTokenKeys.value.indexOf(getRichTokenIdentityKey(first))
				const secondIndex = recentRichTokenKeys.value.indexOf(getRichTokenIdentityKey(second))
				if (firstIndex === -1 && secondIndex === -1) return 0
				if (firstIndex === -1) return 1
				if (secondIndex === -1) return -1
				return firstIndex - secondIndex
			})
			: filteredByType
		return getMatchingRichTokenOptions(candidates, richTokenSearch.value)
	})
	const activeRichTokenIndex = useComputed(() => Math.min(highlightedRichTokenIndex.value, Math.max(0, matchingAvailableRichTokens.value.length - 1)))
	const selectedAvailableRichTokens = useComputed(() => availableRichTokens.value.filter((option) => selectedRichTokenKeys.value.includes(getRichTokenIdentityKey(option))))
	const selectedRichAccountIndex = useComputed(() => richAccounts.value.findIndex((account) => account.addressBookEntry.address === selectedRichAddress.value))
	const showAdjacentRichAccount = (offset: -1 | 1) => {
		if (richTokenPending.value || richAccounts.value.length < 2) return
		const currentIndex = selectedRichAccountIndex.value
		if (currentIndex === -1) return
		const nextIndex = (currentIndex + offset + richAccounts.value.length) % richAccounts.value.length
		const nextAccount = richAccounts.value[nextIndex]
		if (nextAccount === undefined) return
		selectedRichAddress.value = nextAccount.addressBookEntry.address
		showRichTokenPicker.value = false
		resetRichDialogViewState()
	}
	const closeRichBalanceDialog = () => {
		if (richTokenPending.value) return
		showRichBalanceDialog.value = false
		showRichTokenPicker.value = false
		resetRichDialogViewState()
	}
	const showRichTokenSelection = () => {
		showRichTokenPicker.value = true
	}
	const hideRichTokenSelection = () => {
		if (richTokenPending.value) return
		showRichTokenPicker.value = false
		globalThis.queueMicrotask(() => { selectRichTokensButtonRef.current?.focus() })
	}
	const retryFailedRichTokenSelection = () => {
		if (failedAddedRichTokenKey.value === undefined || richTokenPending.value) return
		failedAddedRichTokenKey.value = undefined
		void addSelectedRichTokens()
	}
	const removeFailedRichTokenSelection = () => {
		const failedKey = failedAddedRichTokenKey.value
		if (failedKey === undefined || richTokenPending.value) return
		selectedRichTokenKeys.value = selectedRichTokenKeys.value.filter((key) => key !== failedKey)
		failedAddedRichTokenKey.value = undefined
		richTokenError.value = undefined
		richTokenErrorTarget.value = undefined
	}
	const toggleRichTokenSelection = (option: RichTokenOption) => {
		const key = getRichTokenIdentityKey(option)
		selectedRichTokenKeys.value = selectedRichTokenKeys.value.includes(key)
			? selectedRichTokenKeys.value.filter((selectedKey) => selectedKey !== key)
			: [...selectedRichTokenKeys.value, key]
	}
	const handleRichTokenSearchKeyDown = (event: JSX.TargetedKeyboardEvent<HTMLInputElement>) => {
		const options = matchingAvailableRichTokens.value
		if (options.length === 0) return
		if (event.key === 'ArrowDown') {
			event.preventDefault()
			highlightedRichTokenIndex.value = (highlightedRichTokenIndex.value + 1) % options.length
			return
		}
		if (event.key === 'ArrowUp') {
			event.preventDefault()
			highlightedRichTokenIndex.value = (highlightedRichTokenIndex.value - 1 + options.length) % options.length
			return
		}
		if (event.key !== 'Enter') return
		event.preventDefault()
		const option = options[activeRichTokenIndex.value]
		if (option !== undefined) toggleRichTokenSelection(option)
	}
	const renderRichAccountRow = (richListElement: EnrichedRichListElement) => {
		const accountIsRich = richAccounts.value.some((account) => account.addressBookEntry.address === richListElement.addressBookEntry.address)
		const accountProfile = richAccountBalances.value.find((profile) => profile.chainId === chainId && profile.address === richListElement.addressBookEntry.address)
		const isCurrentAddressRow = richListElement.type === 'CurrentActiveAddress'
		const isActiveAddressRow = richListElement.addressBookEntry.address === activeAddress.value?.address
		const configuredAssetCount = accountProfile === undefined ? 0 : accountProfile.tokenBalances.length + 1
		const accountAddress = addressString(richListElement.addressBookEntry.address)
		const accountAddressDescriptionId = `rich-account-address-${ accountAddress.slice(2) }`
		const openBalances = () => {
			selectedRichAddress.value = richListElement.addressBookEntry.address
			showRichBalanceDialog.value = true
		}
		return <div class = { `rich-mode-account-row${ accountIsRich ? ' is-rich' : '' }${ isActiveAddressRow ? ' is-active-account' : '' }` } key = { richListElement.addressBookEntry.address.toString() }>
			<input class = 'rich-mode-account-toggle' type = 'checkbox' disabled = { !isInitialHomeDataLoaded.value } checked = { isCurrentAddressRow ? makeCurrentAddressRich.value : richListElement.makingRich } aria-label = { `Toggle rich mode for ${ richListElement.addressBookEntry.name } (${ accountAddress })` } onInput = { event => { if (event.target instanceof HTMLInputElement && event.target !== null) { isCurrentAddressRow ? enableMakeCurrentAddressRich(event.target.checked) : modifyRichList(richListElement.addressBookEntry, event.target.checked) } } } />
			<button type = 'button' class = 'rich-mode-account-open' disabled = { !accountIsRich } aria-label = { `Edit balances for ${ richListElement.addressBookEntry.name }` } aria-describedby = { accountAddressDescriptionId } data-configured-assets = { configuredAssetCount.toString() } onClick = { openBalances }>
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
					<input type = 'checkbox' disabled = { !isInitialHomeDataLoaded.value } checked = { makeCurrentAddressRich.value } onInput = { e => { if (e.target instanceof HTMLInputElement && e.target !== null) { enableMakeCurrentAddressRich(e.target.checked) } } } onClick = { event => { event.stopPropagation() } } />
					<p class = 'paragraph checkbox-text' style = 'white-space: nowrap;'> Make current account rich</p>
				</label>
			</p>
			<button type = 'button' class = 'card-header-icon noselect rich-mode-card-header-summary' aria-controls = 'rich-mode-account-manager' aria-expanded = { showList.value } aria-label = { showList.value ? 'Hide rich accounts' : 'Show rich accounts' } onClick = { () => { showList.value = !showList.value } }>
				<span>{ richAccounts.value.length.toString() } account{ richAccounts.value.length === 1 ? '' : 's' } · { richAssetCount.value.toString() } asset{ richAssetCount.value === 1 ? '' : 's' }</span>
				<span class = 'icon'><ChevronIcon /></span>
			</button>
		</header>
		{ !showList.value
			? <> { !activeAddressSetAsRichViaFixedAddressList.value || activeAddress.value === undefined ? <></> : <>
				<div class = 'card-content-header' style = 'font-size: 0.8em;'>
					<label class = 'form-control' style = 'gap: 1em;'>
						<input type = 'checkbox' disabled = { !isInitialHomeDataLoaded.value } checked = { true } onInput = { e => { if (e.target instanceof HTMLInputElement && e.target !== null && activeAddress.value !== undefined) { modifyRichList(activeAddress.value, e.target.checked) } } } />
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
		{ !showRichBalanceDialog.value || selectedRichAccount.value === undefined
			? <></>
			: <div
				class = 'modal is-active rich-mode-modal-layer'
				onKeyDown = { event => {
					if (event.key !== 'Escape' || richTokenPending.value) return
					showRichTokenPicker.value ? hideRichTokenSelection() : closeRichBalanceDialog()
				} }
			>
				<InterceptorDialogSurface ariaLabel = { showRichTokenPicker.value ? `Select tokens for ${ selectedRichAccount.value.addressBookEntry.name }` : `Balance editor for ${ selectedRichAccount.value.addressBookEntry.name }` } class = 'rich-mode-modal-card' onBackdropClick = { closeRichBalanceDialog } size = 'large'>
					<InterceptorDialogHeader
						accessory = { <div class = 'rich-mode-header-tools'>
							{ richOperationStatus.value === undefined ? <></> : <span class = { `rich-mode-save-status ${ richOperationStatus.value.className }` } role = 'status'>{ richOperationStatus.value.label }</span> }
							{ showRichTokenPicker.value || richAccounts.value.length < 2 ? <></> : <div class = 'rich-mode-header-account-switcher' aria-label = 'Rich account navigation'>
								<button type = 'button' class = 'btn btn--ghost is-small' aria-label = 'Previous rich account' disabled = { richTokenPending.value } onClick = { () => { showAdjacentRichAccount(-1) } }>‹</button>
								<span>{ (selectedRichAccountIndex.value + 1).toString() } / { richAccounts.value.length.toString() }</span>
								<button type = 'button' class = 'btn btn--ghost is-small' aria-label = 'Next rich account' disabled = { richTokenPending.value } onClick = { () => { showAdjacentRichAccount(1) } }>›</button>
							</div> }
						</div> }
						close = { closeRichBalanceDialog }
						closeDisabled = { richTokenPending.value }
						closeLabel = 'Close balance manager'
						icon = '../img/address-book.svg'
						iconContent = { <AddressIcon address = { selectedRichAccount.value.addressBookEntry.address } logoUri = { 'logoUri' in selectedRichAccount.value.addressBookEntry ? selectedRichAccount.value.addressBookEntry.logoUri : undefined } isBig = { false } backgroundColor = 'var(--surface-dark-color)'/> }
						title = 'Balances'
						subtitle = { selectedRichAccount.value.addressBookEntry.name }
					/>
					<InterceptorDialogBody class = { `rich-mode-dialog-body${ showRichTokenPicker.value ? ' is-token-view' : '' }` }>
						{ !showRichTokenPicker.value ? <div class = 'rich-mode-balance-page'>
								<div class = 'rich-mode-modal-toolbar'>
									<span class = 'rich-mode-count-badge'>{ richBalanceAssetStatusLabel.value }</span>
									<div class = 'actions'>
										<button type = 'button' class = 'btn btn--ghost is-small' aria-label = 'Open token address book' data-tooltip = 'Open token address book' onClick = { () => { void sendPopupMessageToBackgroundPage({ method: 'popup_openAddressBook' }) } }>
											<span class = 'icon'><img src = '../img/address-book.svg' width = '18' height = '18'/></span>
										</button>
									<button type = 'button' class = 'btn btn--outline is-small' aria-label = 'Select tokens' ref = { selectRichTokensButtonRef } disabled = { richTokenPending.value || selectedRichProfile.value === undefined || availableRichTokens.value.length === 0 } onClick = { showRichTokenSelection }>Select tokens</button>
									</div>
								</div>
								{ selectedRichProfile.value === undefined ? <p class = 'help'>This account has no balance profile.</p> : <>
									<div class = 'rich-mode-balance-rows'>
									<RichBalanceRow
										class = 'rich-mode-balance-row--native'
										label = { nativeCurrencyTicker }
										logoUri = { nativeCurrencyTicker === 'ETH' ? '../img/coins/ethereum.png' : undefined }
										name = 'Native currency'
										balance = { <RichAmountEditor amount = { selectedRichProfile.value.nativeAmount } defaultAmount = { richNativeAmount.value } decimals = { 18 } disabled = { richTokenPending.value } error = { richTokenErrorTarget.value === 'native' ? richTokenError.value : undefined } label = { `${ nativeCurrencyTicker } rich amount for ${ selectedRichAccount.value.addressBookEntry.name }` } unit = { nativeCurrencyTicker } onCommit = { setNativeAmount } onReset = { () => { richTokenError.value = undefined; richTokenErrorTarget.value = undefined; void saveNativeAmount(richNativeAmount.value) } }/> }
									/>
										<div aria-busy = { richTokenPending.value } aria-label = 'Configured rich tokens' class = 'rich-mode-configured-tokens'>
											{ enabledRichTokens.value.length !== 0 || addingRichTokens.value.length !== 0 || failedAddedRichToken.value !== undefined ? <></> : <div class = 'rich-mode-empty-state'>
												<span class = 'rich-mode-empty-state-icon' aria-hidden = 'true'>+</span>
												<span><strong>Only { nativeCurrencyTicker }</strong><small>Add an address-book token.</small></span>
												<button type = 'button' class = 'btn btn--ghost is-small' disabled = { richTokenPending.value || availableRichTokens.value.length === 0 } onClick = { showRichTokenSelection }>Select token</button>
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
											balance = { <RichAmountEditor amount = { option.amount } autoFocus = { newlyAddedRichTokenKeys.value[0] === getRichTokenIdentityKey(option) } defaultAmount = { getDefaultRichTokenAmount(option.decimals) } decimals = { Number(option.decimals) } disabled = { !option.enabled || richTokenPending.value } error = { richTokenErrorTarget.value === getRichTokenIdentityKey(option) ? richTokenError.value : undefined } label = { `${ getRichTokenLabel(option) } rich amount` } unit = { option.symbol } onCommit = { input => { void setRichTokenAmount(option, input) } } onReset = { () => { richTokenError.value = undefined; richTokenErrorTarget.value = undefined; void saveRichTokenAmount(option, getDefaultRichTokenAmount(option.decimals)) } }/> }
											action = { <button type = 'button' class = 'btn btn--ghost is-small rich-mode-remove-token' disabled = { richTokenPending.value } aria-label = { `Remove rich token ${ getRichTokenLabel(option) }` } data-tooltip = 'Remove token' onClick = { () => { void setRichTokenEnabled(option, false) } }><TrashIcon/></button> }
										/>) }
										</div>
									</div>
								</> }
							{ richTokenPendingLabel.value === undefined ? <></> : <p class = 'help is-light' role = 'status'>{ richTokenPendingLabel.value }</p> }
							{ richTokenError.value === undefined || richTokenErrorTarget.value !== undefined ? <></> : <p class = 'help is-danger'>{ richTokenError.value }</p> }
						</div> : <section class = 'rich-mode-token-view' role = 'region' aria-label = { `Select tokens for ${ selectedRichAccount.value.addressBookEntry.name }` }>
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
								<button type = 'button' disabled = { richTokenPending.value } aria-pressed = { richTokenFilter.value === 'All' } onClick = { () => { richTokenFilter.value = 'All'; highlightedRichTokenIndex.value = 0 } }>All</button>
								<button type = 'button' disabled = { richTokenPending.value } aria-pressed = { richTokenFilter.value === 'ERC20' } onClick = { () => { richTokenFilter.value = 'ERC20'; highlightedRichTokenIndex.value = 0 } }>ERC20</button>
								<button type = 'button' disabled = { richTokenPending.value } aria-pressed = { richTokenFilter.value === 'ERC1155' } onClick = { () => { richTokenFilter.value = 'ERC1155'; highlightedRichTokenIndex.value = 0 } }>ERC1155</button>
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
					</section> }
					</InterceptorDialogBody>
					{ !showRichTokenPicker.value ? <></> : <InterceptorDialogFooter class = 'rich-mode-token-view-footer'>
						<button type = 'button' class = 'btn btn--ghost' disabled = { richTokenPending.value } onClick = { hideRichTokenSelection }>Back</button>
						<span class = 'rich-mode-token-selection-count rich-mode-count-badge'>{ selectedAvailableRichTokens.value.length.toString() } selected</span>
						<button type = 'button' class = 'btn btn--primary' aria-label = 'Add selected tokens' disabled = { richTokenPending.value || selectedAvailableRichTokens.value.length === 0 } onClick = { () => { void addSelectedRichTokens() } }>Add { selectedAvailableRichTokens.value.length === 0 ? '' : selectedAvailableRichTokens.value.length.toString() } token{ selectedAvailableRichTokens.value.length === 1 ? '' : 's' }</button>
					</InterceptorDialogFooter> }
				</InterceptorDialogSurface>
			</div>
		}
	</>
}
