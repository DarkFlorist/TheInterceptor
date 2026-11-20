import { type ReadonlySignal, type Signal, useComputed, useSignal, useSignalEffect } from '@preact/signals'
import type { JSX } from 'preact'
import { useRef } from 'preact/hooks'
import { sendPopupMessageToBackgroundPage, sendPopupMessageWithReply } from '../../background/backgroundUtils.js'
import type { AddressBookEntry } from '../../types/addressBookTypes.js'
import type { EnrichedRichListElement, RichTokenSimulationRefresh } from '../../types/interceptor-reply-messages.js'
import type { RichAccountBalance, RichTokenOption } from '../../types/richMode.js'
import type { RenameAddressCallBack } from '../../types/user-interface-types.js'
import { formatUnits } from '../../utils/ethereumUnits.js'
import { getMatchingRichTokenOptions, getRichTokenIdentityKey, getRichTokenLabel, parseRichTokenAmountInput, sameRichTokenIdentity } from '../../utils/richTokens.js'
import { updateRichListAddress } from '../../utils/richList.js'
import { assertNever } from '../../utils/typescript.js'
import { AddressIcon } from '../subcomponents/address.js'
import { InterceptorDialogBody, InterceptorDialogHeader, InterceptorDialogSurface } from '../subcomponents/InterceptorDialog.js'
import { useAsyncState } from '../../utils/preact-utilities.js'
import { RichModeAccountList } from '../subcomponents/RichModeAccountList.js'
import { RichModeBalanceEditor } from '../subcomponents/RichModeBalanceEditor.js'
import { findFundedRichTokenOption, KEEPS_AMOUNT_EDIT_SELECTOR } from '../subcomponents/RichModeShared.js'
import { type RichTokenFilter, RichModeTokenPicker, RichModeTokenPickerFooter } from '../subcomponents/RichModeTokenPicker.js'

type RichModeAccountManagerProps = {
	isSettingsChangePending: ReadonlySignal<boolean>
	setRichState: (enabled: boolean, address: bigint | 'CurrentAddress') => Promise<void>
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

const SAVED_BUT_SIMULATION_UNAVAILABLE_MESSAGE = 'The token funding was saved, but the latest simulation is unavailable. Please refresh the simulation to retry.'
const SAVED_WITH_NEWER_REFRESH_PENDING_MESSAGE = 'The token funding was saved. A newer simulation refresh is in progress; its result will update the simulation.'

// Owns rich-mode state and the background requests; the account list, balance editor and token picker views render it.
export function RichModeAccountManager({ isSettingsChangePending, setRichState, makeCurrentAddressRich, richNativeAmount, nativeCurrencyTicker, activeAddress, richList, richTokenOptions, richAccountBalances, chainId, renameAddressCallBack, isInitialHomeDataLoaded }: RichModeAccountManagerProps) {
	const { value: richChangeState, waitFor: waitForRichChange } = useAsyncState<void>()
	const controlsDisabled = !isInitialHomeDataLoaded.value || isSettingsChangePending.value || richChangeState.value.state === 'pending'
	const saveRichChange = (enabled: boolean, address: bigint | 'CurrentAddress') => {
		void waitForRichChange(async () => {
			try {
				await setRichState(enabled, address)
			} catch (error) {
				// Reload persisted balances when a saved setting cannot be visualized.
				await sendPopupMessageToBackgroundPage({ method: 'popup_requestNewHomeData', data: { refreshSignerAccounts: false, includeWebsiteAccessAddressMetadata: false } })
				throw error
			}
		})
	}
	const selectRichTokensButtonRef = useRef<HTMLButtonElement>(null)
	function enableMakeCurrentAddressRich(enabled: boolean) {
		if (controlsDisabled) return
		saveRichChange(enabled, 'CurrentAddress')
		makeCurrentAddressRich.value = enabled
		const address = activeAddress.value?.address
		if (enabled && address !== undefined && !richAccountBalances.value.some((profile) => profile.chainId === chainId && profile.address === address)) {
			richAccountBalances.value = [...richAccountBalances.value, { chainId, address, nativeAmount: richNativeAmount.value, tokenBalances: [] }]
		}
	}
	function modifyRichList(addressBookEntry: AddressBookEntry, makeRich: boolean) {
		if (controlsDisabled) return
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
		saveRichChange(makeRich, addressBookEntry.address)
	}

	const richTokenError = useSignal<string | undefined>(undefined)
	const richTokenErrorTarget = useSignal<string | undefined>(undefined)
	const richTokenPending = useSignal(false)
	const richTokenPendingKey = useSignal<string | undefined>(undefined)
	const richTokenPendingLabel = useSignal<string | undefined>(undefined)
	const richTokenNotice = useSignal<string | undefined>(undefined)
	const richTokenSaveConfirmedAddress = useSignal<bigint | undefined>(undefined)
	const richTokenSearch = useSignal('')
	const richTokenFilter = useSignal<RichTokenFilter>('All')
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
		richTokenNotice.value = undefined
	}
	const reportSimulationRefreshOutcome = (simulationRefresh: RichTokenSimulationRefresh) => {
		switch (simulationRefresh) {
			case 'Refreshed': return
			case 'Superseded': {
				richTokenNotice.value = SAVED_WITH_NEWER_REFRESH_PENDING_MESSAGE
				return
			}
			case 'Unavailable': {
				richTokenError.value = SAVED_BUT_SIMULATION_UNAVAILABLE_MESSAGE
				richTokenErrorTarget.value = undefined
				return
			}
			default: return assertNever(simulationRefresh)
		}
	}
	const runRichOperation = async <Result,>(key: string, label: string, operation: () => Promise<Result>) => {
		richTokenPending.value = true
		richTokenPendingKey.value = key
		richTokenPendingLabel.value = label
		richTokenSaveConfirmedAddress.value = undefined
		richTokenError.value = undefined
		richTokenErrorTarget.value = undefined
		richTokenNotice.value = undefined
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
		// A successful add has stored a layout for the token, so its option is funded from now on.
		if (enabled) {
			richTokenOptions.value = richTokenOptions.value.map((entry) => sameRichTokenIdentity(entry, option) ? { ...entry, ...configuredRichToken, enabled: true } : entry)
		}
		updateProfileForAddress(address, (profile) => enabled
			? profile.tokenBalances.some((balance) => sameRichTokenIdentity(balance, option))
				? profile
				: { ...profile, tokenBalances: [...profile.tokenBalances, { tokenAddress: option.tokenAddress, tokenId: option.tokenId, amount: configuredRichToken?.amount ?? option.amount }] }
			: { ...profile, tokenBalances: profile.tokenBalances.filter((balance) => !sameRichTokenIdentity(balance, option)) })
		if (enabled) recentRichTokenKeys.value = [tokenKey, ...recentRichTokenKeys.value.filter((key) => key !== tokenKey)].slice(0, 5)
		richTokenSaveConfirmedAddress.value = address
		reportSimulationRefreshOutcome(reply.result.simulationRefresh)
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
			const reply = await sendPopupMessageWithReply({ method: 'popup_modifyMakeMeRich', data: { nativeAmount: amount, address } })
			if (reply?.ok !== true) {
				updateProfileForAddress(address, (current) => ({ ...current, nativeAmount: previousAmount }))
				// A rejected reply can mean the amount was saved but its simulation refresh failed; reload authoritative balances.
				await sendPopupMessageToBackgroundPage({ method: 'popup_requestNewHomeData', data: { refreshSignerAccounts: false, includeWebsiteAccessAddressMetadata: false } })
			}
			return reply
		})
		if (reply?.ok === true) {
			richTokenSaveConfirmedAddress.value = address
			return
		}
		richTokenError.value = reply === undefined ? 'The background service did not confirm the native balance.' : reply.message
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
		reportSimulationRefreshOutcome(reply.result.simulationRefresh)
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
			.flatMap((profile) => profile.tokenBalances.filter((balance) => findFundedRichTokenOption(richTokenOptions.value, balance) !== undefined).map(getRichTokenIdentityKey)))
		return tokenKeys.size + 1
	})
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
			const option = findFundedRichTokenOption(richTokenOptions.value, balance)
			return option === undefined ? [] : [{ ...option, amount: balance.amount }]
		})
	})
	const availableRichTokens = useComputed(() => richTokenOptions.value.filter((option) => !enabledRichTokens.value.some((enabled) => sameRichTokenIdentity(enabled, option))))
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
	const openBalances = (address: bigint) => {
		selectedRichAddress.value = address
		showRichBalanceDialog.value = true
	}
	const clearRichTokenError = () => {
		richTokenError.value = undefined
		richTokenErrorTarget.value = undefined
	}

	return <>
		<RichModeAccountList
			activeAddress = { activeAddress }
			chainId = { chainId }
			controlsDisabled = { controlsDisabled }
			enableMakeCurrentAddressRich = { enableMakeCurrentAddressRich }
			isInitialHomeDataLoaded = { isInitialHomeDataLoaded }
			makeCurrentAddressRich = { makeCurrentAddressRich }
			modifyRichList = { modifyRichList }
			nativeCurrencyTicker = { nativeCurrencyTicker }
			openBalances = { openBalances }
			renameAddressCallBack = { renameAddressCallBack }
			richAccountBalances = { richAccountBalances }
			richAccounts = { richAccounts }
			richAssetCount = { richAssetCount }
			richChangeState = { richChangeState }
			richList = { richList }
			richTokenOptions = { richTokenOptions }
			visibleRichList = { visibleRichList }
		/>
		{ !showRichBalanceDialog.value || selectedRichAccount.value === undefined
			? <></>
			: <div
				class = 'modal is-active rich-mode-modal-layer'
				onMouseDown = { event => { if (event.target instanceof Element && event.target.closest(KEEPS_AMOUNT_EDIT_SELECTOR) !== null) event.preventDefault() } }
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
						{ !showRichTokenPicker.value
							? <RichModeBalanceEditor
								accountName = { selectedRichAccount.value.addressBookEntry.name }
								addingRichTokens = { addingRichTokens }
								availableRichTokens = { availableRichTokens }
								clearRichTokenError = { clearRichTokenError }
								enabledRichTokens = { enabledRichTokens }
								failedAddedRichToken = { failedAddedRichToken }
								nativeCurrencyTicker = { nativeCurrencyTicker }
								newlyAddedRichTokenKeys = { newlyAddedRichTokenKeys }
								profile = { selectedRichProfile.value }
								removeFailedRichTokenSelection = { removeFailedRichTokenSelection }
								retryFailedRichTokenSelection = { retryFailedRichTokenSelection }
								richBalanceAssetStatusLabel = { richBalanceAssetStatusLabel }
								richNativeAmount = { richNativeAmount }
								richTokenError = { richTokenError }
								richTokenErrorTarget = { richTokenErrorTarget }
								richTokenPending = { richTokenPending }
								richTokenPendingKey = { richTokenPendingKey }
								richTokenNotice = { richTokenNotice }
								richTokenPendingLabel = { richTokenPendingLabel }
								saveNativeAmount = { saveNativeAmount }
								saveRichTokenAmount = { saveRichTokenAmount }
								selectRichTokensButtonRef = { selectRichTokensButtonRef }
								setNativeAmount = { setNativeAmount }
								setRichTokenAmount = { setRichTokenAmount }
								setRichTokenEnabled = { setRichTokenEnabled }
								showRichTokenSelection = { showRichTokenSelection }
							/>
							: <RichModeTokenPicker
								accountName = { selectedRichAccount.value.addressBookEntry.name }
								activeRichTokenIndex = { activeRichTokenIndex }
								availableRichTokens = { availableRichTokens }
								failedAddedRichToken = { failedAddedRichToken }
								handleRichTokenSearchKeyDown = { handleRichTokenSearchKeyDown }
								hideRichTokenSelection = { hideRichTokenSelection }
								highlightedRichTokenIndex = { highlightedRichTokenIndex }
								matchingAvailableRichTokens = { matchingAvailableRichTokens }
								recentRichTokenKeys = { recentRichTokenKeys }
								richTokenError = { richTokenError }
								richTokenFilter = { richTokenFilter }
								richTokenPending = { richTokenPending }
								richTokenPendingKey = { richTokenPendingKey }
								richTokenResultsScrollTop = { richTokenResultsScrollTop }
								richTokenSearch = { richTokenSearch }
								selectedAvailableRichTokens = { selectedAvailableRichTokens }
								selectedRichTokenKeys = { selectedRichTokenKeys }
								toggleRichTokenSelection = { toggleRichTokenSelection }
							/> }
					</InterceptorDialogBody>
					{ !showRichTokenPicker.value ? <></> : <RichModeTokenPickerFooter
						addSelectedRichTokens = { addSelectedRichTokens }
						hideRichTokenSelection = { hideRichTokenSelection }
						richTokenPending = { richTokenPending }
						selectedAvailableRichTokens = { selectedAvailableRichTokens }
					/> }
				</InterceptorDialogSurface>
			</div>
		}
	</>
}
