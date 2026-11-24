import * as assert from 'node:assert'
import { test } from 'bun:test'
import { signal } from '@preact/signals'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { useRichBalanceDialog } from '../../app/ts/components/hooks/useRichBalanceDialog.js'
import type { EnrichedRichListElement } from '../../app/ts/types/interceptor-reply-messages.js'
import { installDomMock } from './domMock.js'

const account = (address: bigint): EnrichedRichListElement => ({ addressBookEntry: { type: 'contact', name: `Account ${ address.toString() }`, address, entrySource: 'User' }, makingRich: true, type: 'UserAdded' })

test('the balance dialog hook runs its lifecycle on its own and reports every reset to its caller', async () => {
	const dom = installDomMock()
	const richFundingChainId = signal<bigint | undefined>(1n)
	const richAccounts = signal<readonly EnrichedRichListElement[]>([account(1n), account(2n), account(3n)])
	const operationPending = signal(false)
	const selectedAddress = signal<bigint | undefined>(undefined)
	let resets = 0
	let dialog: ReturnType<typeof useRichBalanceDialog> | undefined
	function Harness() {
		dialog = useRichBalanceDialog({ richFundingChainId, richAccounts, operationPending, selectedAddress, onReset: () => { resets += 1 } })
		return undefined
	}
	try {
		await act(() => { render(h(Harness, {}), dom.document.body) })
		if (dialog === undefined) throw new Error('Expected the dialog hook')
		assert.equal(resets, 0, 'mounting does not reset')

		await act(() => { dialog?.openBalances(2n) })
		assert.equal(dialog.showDialog.value, true)
		assert.equal(dialog.selectedAccount.value?.addressBookEntry.address, 2n)
		assert.equal(dialog.selectedAccountIndex.value, 1)

		// Switching accounts wraps around and resets the view; it is blocked while a funding change runs.
		await act(() => { dialog?.openPicker(); dialog?.showAdjacentAccount(1) })
		assert.equal(selectedAddress.value, 3n)
		assert.equal(dialog.showPicker.value, false)
		assert.equal(resets, 1)
		await act(() => { dialog?.showAdjacentAccount(1) })
		assert.equal(selectedAddress.value, 1n)
		await act(() => { operationPending.value = true; dialog?.showAdjacentAccount(1); dialog?.close() })
		assert.equal(selectedAddress.value, 1n)
		assert.equal(dialog.showDialog.value, true, 'the dialog stays open while a funding change runs')
		await act(() => { operationPending.value = false })

		// The dialog closes and resets when its account stops being rich, and when the funding chain changes.
		await act(() => {
			if (dialog !== undefined) dialog.addingKeys.value = ['token']
			richAccounts.value = [account(2n), account(3n)]
		})
		assert.equal(dialog.showDialog.value, false)
		assert.equal(selectedAddress.value, undefined)
		assert.deepEqual(dialog.addingKeys.value, [])
		const resetsBeforeChainChange = resets
		await act(() => { dialog?.openBalances(3n) })
		await act(() => { richFundingChainId.value = 10n })
		assert.equal(dialog.showDialog.value, false)
		assert.equal(selectedAddress.value, undefined)
		assert.equal(resets, resetsBeforeChainChange + 1)
	} finally {
		render(undefined, dom.document.body)
		dom.restore()
	}
})
