import { type ReadonlySignal, type Signal, useComputed, useSignal, useSignalEffect } from '@preact/signals'
import type { ChangeRichSettings } from '../popupSettingsChange.js'
import type { JSX } from 'preact'
import { useRef } from 'preact/hooks'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import type { AddressBookEntry } from '../../types/addressBookTypes.js'
import type { EnrichedRichListElement, RichTokenSimulationRefresh } from '../../types/interceptor-reply-messages.js'
import type { RichAccountBalance, RichTokenOption } from '../../types/richMode.js'
import { formatUnits } from '../../utils/ethereumUnits.js'
import { getMatchingRichTokenOptions, getRichTokenIdentityKey, getRichTokenLabel, parseRichTokenAmountInput, sameRichTokenIdentity } from '../../utils/richTokens.js'
import { addressesBeingMadeRich } from '../../utils/richModeDerivation.js'
import { assertNever } from '../../utils/typescript.js'
import { useAsyncState } from '../../utils/preact-utilities.js'
import { findFundedRichTokenOption } from '../subcomponents/RichModeShared.js'

export type RichTokenFilter = 'All' | 'ERC20' | 'ERC1155'

export type RichModeTokenInputs = {
	isSettingsChangePending: ReadonlySignal<boolean>
	changeRichSettings: ChangeRichSettings
	makeCurrentAddressRich: ReadonlySignal<boolean>
	richNativeAmount: ReadonlySignal<bigint>
	nativeCurrencyTicker: string
	activeAddress: Signal<AddressBookEntry | undefined>
	richList: ReadonlySignal<readonly EnrichedRichListElement[]>
	richTokenOptions: ReadonlySignal<readonly RichTokenOption[]>
	richAccountBalances: ReadonlySignal<readonly RichAccountBalance[]>
	richFundingChainId: ReadonlySignal<bigint | undefined>
	isInitialHomeDataLoaded: Signal<boolean>
}

const SAVED_BUT_SIMULATION_UNAVAILABLE_MESSAGE = 'The token funding was saved, but the latest simulation is unavailable. Please refresh the simulation to retry.'
const SAVED_WITH_NEWER_REFRESH_PENDING_MESSAGE = 'The token funding was saved. A newer simulation refresh is in progress; its result will update the simulation.'

// Owns local editing progress and derives immutable views of the authoritative funding snapshot.
export function useRichModeTokens({ isSettingsChangePending, changeRichSettings, makeCurrentAddressRich, richNativeAmount, nativeCurrencyTicker, activeAddress, richList, richTokenOptions, richAccountBalances, richFundingChainId, isInitialHomeDataLoaded }: RichModeTokenInputs) {
	const { value: richChangeState, waitFor: waitForRichChange } = useAsyncState<void>()
	const richTokenPending = useSignal(false)
	const richMutationPending = useComputed(() => isSettingsChangePending.value || richTokenPending.value || richChangeState.value.state === 'pending')
	const controlsDisabled = useComputed(() => richFundingChainId.value === undefined || !isInitialHomeDataLoaded.value || richMutationPending.value)
	const reloadRichState = async () => await sendPopupMessageToBackgroundPage({ method: 'popup_requestNewHomeData', data: { refreshSignerAccounts: false, includeWebsiteAccessAddressMetadata: false } })
	const saveRichChange = (enabled: boolean, address: bigint | 'CurrentAddress') => {
		void waitForRichChange(async () => {
			try {
				const result = await changeRichSettings({ method: 'popup_modifyMakeMeRich', data: { action: 'set-address-rich', add: enabled, address } })
				// The async state shows a rejected change as its error.
				if (!result.ok) throw new Error(result.error)
			} finally {
				// Reload persisted balances after failures too, because a saved setting may not have been visualized.
				await reloadRichState()
			}
		})
	}
	const selectRichTokensButtonRef = useRef<HTMLButtonElement>(null)
	function enableMakeCurrentAddressRich(enabled: boolean) {
		if (controlsDisabled.peek()) return
		saveRichChange(enabled, 'CurrentAddress')
	}
	function modifyRichList(addressBookEntry: AddressBookEntry, makeRich: boolean) {
		if (controlsDisabled.peek()) return
		saveRichChange(makeRich, addressBookEntry.address)
	}

	const richTokenError = useSignal<string | undefined>(undefined)
	const richTokenErrorTarget = useSignal<string | undefined>(undefined)
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

	useSignalEffect(() => {
		const savedAddress = richTokenSaveConfirmedAddress.value
		if (savedAddress === undefined) return
		// The pinned signals hook forwards this cleanup to the core effect; the identity guard also protects a callback already queued before cancellation.
		let active = true
		const timeout = globalThis.setTimeout(() => { if (active && richTokenSaveConfirmedAddress.peek() === savedAddress) richTokenSaveConfirmedAddress.value = undefined }, 1600)
		return () => { active = false; globalThis.clearTimeout(timeout) }
	})
	useSignalEffect(() => {
		const addedKeys = newlyAddedRichTokenKeys.value
		if (addedKeys.length === 0) return
		let active = true
		const timeout = globalThis.setTimeout(() => { if (active && newlyAddedRichTokenKeys.peek() === addedKeys) newlyAddedRichTokenKeys.value = [] }, 1800)
		return () => { active = false; globalThis.clearTimeout(timeout) }
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
	const previousFundingChainId = useRef(richFundingChainId.peek())
	useSignalEffect(() => {
		const chainId = richFundingChainId.value
		if (previousFundingChainId.current === chainId) return
		previousFundingChainId.current = chainId
		showRichBalanceDialog.value = false
		showRichTokenPicker.value = false
		selectedRichAddress.value = undefined
		resetRichDialogViewState()
	})
	const reportSimulationRefreshOutcome = (simulationRefresh: RichTokenSimulationRefresh | undefined) => {
		switch (simulationRefresh) {
			case undefined:
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
			let result: Result | undefined
			try {
				result = await operation()
			} catch (error) {
				richTokenError.value = error instanceof Error ? error.message : 'The funding change could not be completed.'
				richTokenErrorTarget.value = key
			}
			// A missing reply may follow a committed write, so refresh persisted funding on failures too.
			await reloadRichState()
			return result
		} finally {
			richTokenPending.value = false
			richTokenPendingKey.value = undefined
			richTokenPendingLabel.value = undefined
		}
	}

	const setRichTokenEnabled = async (option: RichTokenOption, enabled: boolean, targetAddress?: bigint, chainId = richFundingChainId.peek()) => {
		const address = targetAddress ?? selectedRichAccount.value?.addressBookEntry.address
		if (chainId === undefined || controlsDisabled.peek() || address === undefined) return false
		const tokenKey = getRichTokenIdentityKey(option)
		const reply = await runRichOperation(
			tokenKey,
			enabled ? `Preparing ${ getRichTokenLabel(option) }…` : `Removing ${ getRichTokenLabel(option) } from rich mode…`,
			async () => await changeRichSettings({
				method: 'popup_modifyRichToken',
				data: { action: enabled ? 'Add' : 'Remove', chainId, address, tokenAddress: option.tokenAddress, tokenId: option.tokenId },
			}),
		)
		if (reply === undefined) {
			richTokenError.value ??= 'The background service did not return a token funding result.'
			richTokenErrorTarget.value = tokenKey
			return false
		}
		if (!reply.ok) {
			richTokenError.value = reply.error
			richTokenErrorTarget.value = tokenKey
			return false
		}

		if (enabled) recentRichTokenKeys.value = [tokenKey, ...recentRichTokenKeys.value.filter((key) => key !== tokenKey)].slice(0, 5)
		richTokenSaveConfirmedAddress.value = address
		reportSimulationRefreshOutcome(reply.simulationRefresh)
		return true
	}

	const addSelectedRichTokens = async () => {
		const chainId = richFundingChainId.peek()
		const address = selectedRichAccount.value?.addressBookEntry.address
		if (chainId === undefined || address === undefined || controlsDisabled.peek()) return
		const options = availableRichTokens.value.filter((option) => selectedRichTokenKeys.value.includes(getRichTokenIdentityKey(option)))
		if (options.length === 0) return
		showRichTokenPicker.value = false
		addingRichTokenKeys.value = options.map(getRichTokenIdentityKey)
		failedAddedRichTokenKey.value = undefined
		const addedKeys: string[] = []
		for (const option of options) {
			const tokenKey = getRichTokenIdentityKey(option)
			if (!await setRichTokenEnabled(option, true, address, chainId)) {
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
		const chainId = richFundingChainId.peek()
		const address = selectedRichAccount.value?.addressBookEntry.address
		const profile = selectedRichProfile.value
		if (chainId === undefined || address === undefined || profile === undefined || controlsDisabled.peek()) return
		const reply = await runRichOperation('native', `Saving ${ nativeCurrencyTicker } amount…`, async () => await changeRichSettings({ method: 'popup_modifyMakeMeRich', data: { action: 'set-native-amount', chainId, nativeAmount: amount, address } }))
		if (reply?.ok === true) {
			richTokenSaveConfirmedAddress.value = address
			return
		}
		richTokenError.value ??= reply === undefined ? 'The background service did not confirm the native balance.' : reply.error
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
		const chainId = richFundingChainId.peek()
		const address = selectedRichAccount.value?.addressBookEntry.address
		if (chainId === undefined || address === undefined) return
		if (controlsDisabled.peek()) return
		const tokenKey = getRichTokenIdentityKey(option)
		const reply = await runRichOperation(tokenKey, `Saving ${ getRichTokenLabel(option) } amount…`, async () => await changeRichSettings({ method: 'popup_modifyRichToken', data: { action: 'SetAmount', chainId, address, tokenAddress: option.tokenAddress, tokenId: option.tokenId, amount } }))
		if (reply === undefined) {
			richTokenError.value ??= 'The background service did not return a token funding result.'
			richTokenErrorTarget.value = tokenKey
			return
		}
		if (!reply.ok) {
			richTokenError.value = reply.error
			richTokenErrorTarget.value = tokenKey
			return
		}
		richTokenSaveConfirmedAddress.value = address
		reportSimulationRefreshOutcome(reply.simulationRefresh)
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
		const current = activeAddress.value
		// Home mounts this manager only in simulation mode. Use the simulation input's funding rule for the displayed accounts too.
		const fundedAddresses = new Set(addressesBeingMadeRich({ simulationMode: true, activeSimulationAddress: current?.address }, {
			makeCurrentAddressRich: makeCurrentAddressRich.value,
			fixedAddressRichList: richList.value.map(({ addressBookEntry, makingRich, type }) => ({ address: addressBookEntry.address, makingRich, type })),
		}))
		const fixed = richList.value.filter((element) => element.makingRich && fundedAddresses.has(element.addressBookEntry.address))
		if (current === undefined || !fundedAddresses.has(current.address) || fixed.some((element) => element.addressBookEntry.address === current.address)) return fixed
		return [{ addressBookEntry: current, makingRich: true, type: 'CurrentActiveAddress' as const }, ...fixed]
	})
	const richAssetCount = useComputed(() => {
		if (richAccounts.value.length === 0) return 0
		const accountAddresses = new Set(richAccounts.value.map((account) => account.addressBookEntry.address))
		const tokenKeys = new Set(richAccountBalances.value
			.filter((profile) => profile.chainId === richFundingChainId.value && accountAddresses.has(profile.address))
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
		return richAccountBalances.value.find((profile) => profile.chainId === richFundingChainId.value && profile.address === address)
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

	const feedback = useComputed(() => ({
		richTokenError: richTokenError.value,
		richTokenErrorTarget: richTokenErrorTarget.value,
		richTokenPending: richMutationPending.value,
		richTokenPendingKey: richTokenPendingKey.value,
		richTokenNotice: richTokenNotice.value,
		richTokenPendingLabel: richTokenPendingLabel.value,
	}))
	const accountsData = useComputed(() => ({
		activeAddress: activeAddress.value,
		richFundingChainId: richFundingChainId.value,
		controlsDisabled: controlsDisabled.value,
		isInitialHomeDataLoaded: isInitialHomeDataLoaded.value,
		makeCurrentAddressRich: makeCurrentAddressRich.value,
		richAccountBalances: richAccountBalances.value,
		richAccounts: richAccounts.value,
		richAssetCount: richAssetCount.value,
		richChangeState: richChangeState.value,
		richList: richList.value,
		richTokenOptions: richTokenOptions.value,
		visibleRichList: visibleRichList.value,
	}))
	const editorData = useComputed(() => ({
		addingRichTokens: addingRichTokens.value,
		availableRichTokens: availableRichTokens.value,
		enabledRichTokens: enabledRichTokens.value,
		failedAddedRichToken: failedAddedRichToken.value,
		newlyAddedRichTokenKeys: newlyAddedRichTokenKeys.value,
		richBalanceAssetStatusLabel: richBalanceAssetStatusLabel.value,
		richNativeAmount: richNativeAmount.value,
		profile: selectedRichProfile.value,
	}))
	const pickerData = useComputed(() => ({
		activeRichTokenIndex: activeRichTokenIndex.value,
		availableRichTokens: availableRichTokens.value,
		failedAddedRichToken: failedAddedRichToken.value,
		matchingAvailableRichTokens: matchingAvailableRichTokens.value,
		recentRichTokenKeys: recentRichTokenKeys.value,
		richTokenFilter: richTokenFilter.value,
		richTokenResultsScrollTop: richTokenResultsScrollTop.value,
		richTokenSearch: richTokenSearch.value,
		selectedAvailableRichTokens: selectedAvailableRichTokens.value,
		selectedRichTokenKeys: selectedRichTokenKeys.value,
	}))
	const dialogData = useComputed(() => ({
		showRichBalanceDialog: showRichBalanceDialog.value,
		showRichTokenPicker: showRichTokenPicker.value,
		selectedRichAccount: selectedRichAccount.value,
		richAccounts: richAccounts.value,
		selectedRichAccountIndex: selectedRichAccountIndex.value,
		richOperationStatus: richOperationStatus.value,
	}))
	return {
		feedback,
		accounts: { data: accountsData, actions: { enableMakeCurrentAddressRich, modifyRichList, openBalances } },
		editor: {
			data: editorData,
			selectRichTokensButtonRef,
			actions: { clearRichTokenError, removeFailedRichTokenSelection, retryFailedRichTokenSelection, saveNativeAmount, saveRichTokenAmount, setNativeAmount, setRichTokenAmount, setRichTokenEnabled, showRichTokenSelection },
		},
		picker: {
			data: pickerData,
			actions: {
				handleRichTokenSearchKeyDown, hideRichTokenSelection, toggleRichTokenSelection, addSelectedRichTokens,
				setSearch: (query: string) => { richTokenSearch.value = query; highlightedRichTokenIndex.value = 0 },
				selectFilter: (filter: RichTokenFilter) => { richTokenFilter.value = filter; highlightedRichTokenIndex.value = 0 },
				clearSelection: () => { selectedRichTokenKeys.value = [] },
				scrollResults: (top: number) => { richTokenResultsScrollTop.value = top },
				highlightToken: (index: number) => { highlightedRichTokenIndex.value = index },
			},
		},
		dialog: { data: dialogData, actions: { closeRichBalanceDialog, hideRichTokenSelection, showAdjacentRichAccount } },
	}
}

export type RichModeTokenController = ReturnType<typeof useRichModeTokens>
