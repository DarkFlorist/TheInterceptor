import { type ReadonlySignal, type Signal, useComputed, useSignal } from '@preact/signals'
import type { ChangeRichSettings } from '../popupSettingsChange.js'
import type { AddressBookEntry } from '../../types/addressBookTypes.js'
import type { EnrichedRichListElement } from '../../types/interceptor-reply-messages.js'
import type { RichAccountBalance, RichTokenOption } from '../../types/richMode.js'
import { formatUnits } from '../../utils/ethereumUnits.js'
import { getRichTokenIdentityKey, parseRichTokenAmountInput, sameRichTokenIdentity } from '../../utils/richTokens.js'
import { addressesBeingMadeRich } from '../../utils/richModeDerivation.js'
import { findFundedRichTokenOption, type RichFundingFeedback } from '../subcomponents/RichModeShared.js'
import type { RichModeAccountListModel } from '../subcomponents/RichModeAccountList.js'
import type { RichModeBalanceEditorModel } from '../subcomponents/RichModeBalanceEditor.js'
import type { RichTokenPickerModel } from '../subcomponents/RichModeTokenPicker.js'
import { useRichBalanceDialog } from './useRichBalanceDialog.js'
import { useRichModeMutations } from './useRichModeMutations.js'
import { useRichTokenPicker } from './useRichTokenPicker.js'

export type { RichTokenFilter } from './useRichTokenPicker.js'

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

export type RichModeDialogModel = {
	readonly data: ReadonlySignal<{
		readonly showRichBalanceDialog: boolean
		readonly showRichTokenPicker: boolean
		readonly selectedRichAccount: EnrichedRichListElement | undefined
		readonly richAccounts: readonly EnrichedRichListElement[]
		readonly selectedRichAccountIndex: number
		readonly richOperationStatus: { readonly className: string, readonly label: string } | undefined
	}>
	readonly actions: {
		readonly closeRichBalanceDialog: () => void
		readonly hideRichTokenSelection: () => void
		readonly showAdjacentRichAccount: (offset: -1 | 1) => void
	}
}

// Composes the rich-mode hooks (funding mutations, the balance dialog and the token picker) over the authoritative funding snapshot, and builds each view's own model from them.
export function useRichModeTokens({ isSettingsChangePending, changeRichSettings, makeCurrentAddressRich, richNativeAmount, nativeCurrencyTicker, activeAddress, richList, richTokenOptions, richAccountBalances, richFundingChainId, isInitialHomeDataLoaded }: RichModeTokenInputs) {
	const mutations = useRichModeMutations({ isSettingsChangePending, changeRichSettings, richFundingChainId, isInitialHomeDataLoaded, nativeCurrencyTicker })

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

	// The composition owns the selected address, so the selected account's tokens and the picker over them exist before the dialog that resets them.
	const selectedRichAddress = useSignal<bigint | undefined>(undefined)
	const selectedRichAccount = useComputed(() => richAccounts.value.find((element) => element.addressBookEntry.address === selectedRichAddress.value))
	const selectedRichProfile = useComputed(() => {
		const address = selectedRichAccount.value?.addressBookEntry.address
		return richAccountBalances.value.find((profile) => profile.chainId === richFundingChainId.value && profile.address === address)
	})
	const enabledRichTokens = useComputed(() => (selectedRichProfile.value?.tokenBalances ?? []).flatMap((balance) => {
		const option = findFundedRichTokenOption(richTokenOptions.value, balance)
		return option === undefined ? [] : [{ ...option, amount: balance.amount }]
	}))
	const availableRichTokens = useComputed(() => richTokenOptions.value.filter((option) => !enabledRichTokens.value.some((enabled) => sameRichTokenIdentity(enabled, option))))
	const picker = useRichTokenPicker({ availableTokens: availableRichTokens })
	const dialog = useRichBalanceDialog({
		richFundingChainId, richAccounts, operationPending: mutations.operationPending, selectedAddress: selectedRichAddress,
		onReset: () => {
			picker.actions.reset()
			mutations.clearFeedback()
		},
	})
	const addingRichTokens = useComputed(() => availableRichTokens.value.filter((option) => dialog.addingKeys.value.includes(getRichTokenIdentityKey(option))))
	const failedAddedRichToken = useComputed(() => availableRichTokens.value.find((option) => getRichTokenIdentityKey(option) === dialog.failedAddedKey.value))

	const selectedAddress = () => selectedRichAccount.value?.addressBookEntry.address
	const enableMakeCurrentAddressRich = (enabled: boolean) => {
		if (mutations.controlsDisabled.peek()) return
		mutations.saveRichChange(enabled, 'CurrentAddress')
	}
	const modifyRichList = (addressBookEntry: AddressBookEntry, makeRich: boolean) => {
		if (mutations.controlsDisabled.peek()) return
		mutations.saveRichChange(makeRich, addressBookEntry.address)
	}
	const setRichTokenEnabled = async (option: RichTokenOption, enabled: boolean, targetAddress?: bigint, chainId = richFundingChainId.peek()) => {
		const address = targetAddress ?? selectedAddress()
		if (chainId === undefined || mutations.controlsDisabled.peek() || address === undefined) return false
		if (!await mutations.changeTokenFunding(option, enabled, address, chainId)) return false
		if (enabled) picker.actions.rememberRecent(getRichTokenIdentityKey(option))
		return true
	}
	const addSelectedRichTokens = async () => {
		const chainId = richFundingChainId.peek()
		const address = selectedAddress()
		if (chainId === undefined || address === undefined || mutations.controlsDisabled.peek()) return
		const options = picker.selectedTokens.value
		if (options.length === 0) return
		dialog.showPicker.value = false
		dialog.addingKeys.value = options.map(getRichTokenIdentityKey)
		dialog.failedAddedKey.value = undefined
		const addedKeys: string[] = []
		for (const option of options) {
			const tokenKey = getRichTokenIdentityKey(option)
			if (!await setRichTokenEnabled(option, true, address, chainId)) {
				dialog.failedAddedKey.value = tokenKey
				break
			}
			addedKeys.push(tokenKey)
			dialog.addingKeys.value = dialog.addingKeys.value.filter((key) => key !== tokenKey)
		}
		dialog.addingKeys.value = []
		picker.actions.deselect(addedKeys)
		if (addedKeys.length !== options.length) return
		dialog.newlyAddedKeys.value = addedKeys
	}
	const saveNativeAmount = async (amount: bigint) => {
		const chainId = richFundingChainId.peek()
		const address = selectedAddress()
		if (chainId === undefined || address === undefined || selectedRichProfile.value === undefined || mutations.controlsDisabled.peek()) return
		await mutations.saveNativeAmount(address, chainId, amount)
	}
	const setNativeAmount = (input: HTMLInputElement) => {
		const profile = selectedRichProfile.value
		if (profile === undefined) return
		mutations.setError(undefined, undefined)
		const parsedAmount = parseRichTokenAmountInput(input.value, 18n)
		if (parsedAmount.valid === false) {
			mutations.setError(parsedAmount.reason === 'ExceedsUint256'
				? `${ nativeCurrencyTicker } amount cannot exceed the maximum uint256 value.`
				: `Enter a positive ${ nativeCurrencyTicker } amount with at most 18 decimal places.`, 'native')
			input.value = formatUnits(profile.nativeAmount, 18)
			return
		}
		void saveNativeAmount(parsedAmount.amount)
	}
	const saveRichTokenAmount = async (option: RichTokenOption, amount: bigint) => {
		const chainId = richFundingChainId.peek()
		const address = selectedAddress()
		if (chainId === undefined || address === undefined || mutations.controlsDisabled.peek()) return
		await mutations.saveTokenAmount(option, address, chainId, amount)
	}
	const setRichTokenAmount = async (option: RichTokenOption, input: HTMLInputElement) => {
		mutations.setError(undefined, undefined)
		const parsedAmount = parseRichTokenAmountInput(input.value, option.decimals)
		if (parsedAmount.valid === false) {
			mutations.setError(parsedAmount.reason === 'ExceedsUint256'
				? 'Token amount cannot exceed the maximum uint256 value.'
				: `Enter a positive ${ option.symbol } amount with at most ${ option.decimals.toString() } decimal places.`, getRichTokenIdentityKey(option))
			input.value = formatUnits(option.amount, Number(option.decimals))
			return
		}
		await saveRichTokenAmount(option, parsedAmount.amount)
	}
	const retryFailedRichTokenSelection = () => {
		if (dialog.failedAddedKey.value === undefined || mutations.operationPending.value) return
		dialog.failedAddedKey.value = undefined
		void addSelectedRichTokens()
	}
	const removeFailedRichTokenSelection = () => {
		const failedKey = dialog.failedAddedKey.value
		if (failedKey === undefined || mutations.operationPending.value) return
		picker.actions.deselect([failedKey])
		dialog.failedAddedKey.value = undefined
		mutations.setError(undefined, undefined)
	}

	const feedback: ReadonlySignal<RichFundingFeedback> = mutations.feedback
	const accounts: RichModeAccountListModel = {
		data: useComputed(() => ({
			activeAddress: activeAddress.value,
			richFundingChainId: richFundingChainId.value,
			controlsDisabled: mutations.controlsDisabled.value,
			isInitialHomeDataLoaded: isInitialHomeDataLoaded.value,
			makeCurrentAddressRich: makeCurrentAddressRich.value,
			richAccountBalances: richAccountBalances.value,
			richAccounts: richAccounts.value,
			richAssetCount: richAssetCount.value,
			richChangeState: mutations.richChangeState.value,
			richList: richList.value,
			richTokenOptions: richTokenOptions.value,
			visibleRichList: visibleRichList.value,
		})),
		actions: { enableMakeCurrentAddressRich, modifyRichList, openBalances: dialog.openBalances },
	}
	const editor: RichModeBalanceEditorModel = {
		data: useComputed(() => ({
			addingRichTokens: addingRichTokens.value,
			availableRichTokens: availableRichTokens.value,
			enabledRichTokens: enabledRichTokens.value,
			failedAddedRichToken: failedAddedRichToken.value,
			newlyAddedRichTokenKeys: dialog.newlyAddedKeys.value,
			richBalanceAssetStatusLabel: addingRichTokens.value.length !== 0
				? `${ addingRichTokens.value.length.toString() } adding`
				: failedAddedRichToken.value !== undefined ? 'Needs attention' : `${ (enabledRichTokens.value.length + 1).toString() } asset${ enabledRichTokens.value.length === 0 ? '' : 's' }`,
			richNativeAmount: richNativeAmount.value,
			profile: selectedRichProfile.value,
		})),
		selectRichTokensButtonRef: dialog.selectRichTokensButtonRef,
		actions: {
			clearRichTokenError: () => { mutations.setError(undefined, undefined) },
			removeFailedRichTokenSelection, retryFailedRichTokenSelection, saveNativeAmount, saveRichTokenAmount, setNativeAmount, setRichTokenAmount, setRichTokenEnabled,
			showRichTokenSelection: dialog.openPicker,
		},
	}
	const pickerModel: RichTokenPickerModel = {
		data: useComputed(() => ({ ...picker.data.value, availableRichTokens: availableRichTokens.value, failedAddedRichToken: failedAddedRichToken.value })),
		actions: {
			handleRichTokenSearchKeyDown: picker.actions.handleSearchKeyDown,
			hideRichTokenSelection: dialog.hidePicker,
			toggleRichTokenSelection: picker.actions.toggleSelection,
			addSelectedRichTokens,
			setSearch: picker.actions.setSearch,
			selectFilter: picker.actions.selectFilter,
			clearSelection: picker.actions.clearSelection,
			scrollResults: picker.actions.scrollResults,
			highlightToken: picker.actions.highlightToken,
		},
	}
	const dialogModel: RichModeDialogModel = {
		data: useComputed(() => ({
			showRichBalanceDialog: dialog.showDialog.value,
			showRichTokenPicker: dialog.showPicker.value,
			selectedRichAccount: dialog.selectedAccount.value,
			richAccounts: richAccounts.value,
			selectedRichAccountIndex: dialog.selectedAccountIndex.value,
			richOperationStatus: mutations.operationPending.value
				? { className: 'is-saving', label: dialog.addingKeys.value.length === 0 ? 'Saving…' : 'Scanning…' }
				: mutations.error.value !== undefined
					? { className: 'is-error', label: 'Needs attention' }
					: mutations.saveConfirmedAddress.value === dialog.selectedAddress.value ? { className: 'is-saved', label: '✓ Saved' } : undefined,
		})),
		actions: { closeRichBalanceDialog: dialog.close, hideRichTokenSelection: dialog.hidePicker, showAdjacentRichAccount: dialog.showAdjacentAccount },
	}
	return { feedback, accounts, editor, picker: pickerModel, dialog: dialogModel }
}

export type RichModeTokenController = ReturnType<typeof useRichModeTokens>
