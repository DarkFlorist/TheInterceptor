import { type ReadonlySignal, type Signal, useComputed, useSignal, useSignalEffect } from '@preact/signals'
import { useRef } from 'preact/hooks'
import type { EnrichedRichListElement } from '../../types/interceptor-reply-messages.js'

type RichBalanceDialogInputs = {
	richFundingChainId: ReadonlySignal<bigint | undefined>
	richAccounts: ReadonlySignal<readonly EnrichedRichListElement[]>
	// While a funding change runs, the dialog stays open on its account.
	operationPending: ReadonlySignal<boolean>
	// The address of the account the dialog shows. The caller owns it, so state derived from the selected account can exist before this hook.
	selectedAddress: Signal<bigint | undefined>
	// Called whenever the dialog resets its view (closing, switching account, a chain change), so the caller can reset state other hooks own.
	onReset: () => void
}

// The balance dialog's lifecycle: which account it shows, whether the token picker is open, the progress of a multi-token add, and the timer that clears the newly-added highlight. It closes itself when the funding chain changes or its account stops being rich.
export function useRichBalanceDialog({ richFundingChainId, richAccounts, operationPending, selectedAddress, onReset }: RichBalanceDialogInputs) {
	const showDialog = useSignal(false)
	const showPicker = useSignal(false)
	const addingKeys = useSignal<readonly string[]>([])
	const failedAddedKey = useSignal<string | undefined>(undefined)
	const newlyAddedKeys = useSignal<readonly string[]>([])
	const selectRichTokensButtonRef = useRef<HTMLButtonElement>(null)

	const reset = () => {
		addingKeys.value = []
		failedAddedKey.value = undefined
		newlyAddedKeys.value = []
		onReset()
	}

	useSignalEffect(() => {
		const addedKeys = newlyAddedKeys.value
		if (addedKeys.length === 0) return
		let active = true
		const timeout = globalThis.setTimeout(() => { if (active && newlyAddedKeys.peek() === addedKeys) newlyAddedKeys.value = [] }, 1800)
		return () => { active = false; globalThis.clearTimeout(timeout) }
	})
	const previousFundingChainId = useRef(richFundingChainId.peek())
	useSignalEffect(() => {
		const chainId = richFundingChainId.value
		if (previousFundingChainId.current === chainId) return
		previousFundingChainId.current = chainId
		showDialog.value = false
		showPicker.value = false
		selectedAddress.value = undefined
		reset()
	})
	const selectedAccount = useComputed(() => richAccounts.value.find((element) => element.addressBookEntry.address === selectedAddress.value))
	useSignalEffect(() => {
		const address = selectedAddress.value
		if (address === undefined || richAccounts.value.some((account) => account.addressBookEntry.address === address)) return
		showDialog.value = false
		showPicker.value = false
		reset()
		selectedAddress.value = undefined
	})
	const selectedAccountIndex = useComputed(() => richAccounts.value.findIndex((account) => account.addressBookEntry.address === selectedAddress.value))

	const openBalances = (address: bigint) => {
		selectedAddress.value = address
		showDialog.value = true
	}
	const close = () => {
		if (operationPending.value) return
		showDialog.value = false
		showPicker.value = false
		reset()
	}
	const showAdjacentAccount = (offset: -1 | 1) => {
		const accounts = richAccounts.value
		if (operationPending.value || accounts.length < 2) return
		const currentIndex = selectedAccountIndex.value
		if (currentIndex === -1) return
		const nextAccount = accounts[(currentIndex + offset + accounts.length) % accounts.length]
		if (nextAccount === undefined) return
		selectedAddress.value = nextAccount.addressBookEntry.address
		showPicker.value = false
		reset()
	}
	const openPicker = () => { showPicker.value = true }
	const hidePicker = () => {
		if (operationPending.value) return
		showPicker.value = false
		globalThis.queueMicrotask(() => { selectRichTokensButtonRef.current?.focus() })
	}

	return {
		showDialog, showPicker, selectedAddress, selectedAccount, selectedAccountIndex,
		addingKeys, failedAddedKey, newlyAddedKeys, selectRichTokensButtonRef,
		openBalances, close, showAdjacentAccount, openPicker, hidePicker,
	}
}
