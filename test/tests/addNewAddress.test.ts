import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { Signal } from '@preact/signals'
import { mergeAddressWindowErrorState, saveAddressBookEntry, saveAddressBookEntryAndSwitch, updateModifyAddressWindowState } from '../../app/ts/components/pages/AddNewAddress.js'
import type { ModifyAddressWindowState } from '../../app/ts/types/visualizer-types.js'

const sampleAddressBookEntry = {
	type: 'contact',
	name: 'Alice',
	address: 1n,
	entrySource: 'User',
} as const
const addNewAddressSource = await Bun.file(new URL('../../app/ts/components/pages/AddNewAddress.tsx', import.meta.url)).text()

describe('add new address save flow', () => {
	test('waits for the save message to finish before closing the popup', async () => {
		const calls: string[] = []
		await saveAddressBookEntry(sampleAddressBookEntry, () => {
			calls.push('close')
		}, async () => {
			calls.push('send:start')
			await Promise.resolve()
			calls.push('send:end')
			return { ok: true }
		})

		assert.deepEqual(calls, ['send:start', 'send:end', 'close'])
	})

	test('does not close the popup when the entry is invalid', async () => {
		let closed = false
		let sent = false

		await saveAddressBookEntry({ type: 'error', error: 'invalid' }, () => {
			closed = true
		}, async () => {
			sent = true
		})

		assert.equal(sent, false)
		assert.equal(closed, false)
	})

	test('shows backend Safe validation errors without closing the popup', async () => {
		let closed = false
		const message = await saveAddressBookEntry(sampleAddressBookEntry, () => {
			closed = true
		}, async () => ({
			ok: false,
			message: 'The configured address is not an owner of this Safe.',
		}))

		assert.equal(closed, false)
		assert.equal(message, 'The configured address is not an owner of this Safe.')
	})

	test('does not close when the background validation reply is missing', async () => {
		let closed = false
		const message = await saveAddressBookEntry(sampleAddressBookEntry, () => {
			closed = true
		}, async () => undefined)

		assert.equal(closed, false)
		assert.equal(message, 'Interceptor did not reply while validating the address-book entry.')
	})

	test('does not switch accounts when backend validation rejects the entry', async () => {
		let closed = false
		let switchedTo: bigint | undefined

		const message = await saveAddressBookEntryAndSwitch(
			sampleAddressBookEntry,
			() => { closed = true },
			async (address) => { switchedTo = address },
			async () => ({
				ok: false,
				message: 'The configured address is not an owner of this Safe.',
			}),
		)

		assert.equal(closed, false)
		assert.equal(switchedTo, undefined)
		assert.equal(message, 'The configured address is not an owner of this Safe.')
	})

	test('keeps non-blocking block explorer errors when validation has no error', () => {
		const blockExplorerError = { blockEditing: false, message: 'No ABI available for this contract.' }

		assert.deepEqual(mergeAddressWindowErrorState(blockExplorerError, undefined), blockExplorerError)
	})

	test('clears blocking validation errors when validation has no error', () => {
		const validationError = { blockEditing: true, message: 'The address is invalid.' }

		assert.equal(mergeAddressWindowErrorState(validationError, undefined), undefined)
	})

	test('shows a non-blocking error when address window state sync fails', async () => {
		const state = new Signal<ModifyAddressWindowState>({
			windowStateId: '1',
			errorState: undefined,
			incompleteAddressBookEntry: {
				addingAddress: false,
				type: 'contract',
				address: '0x0000000000000000000000000000000000000001',
				askForAddressAccess: true,
				name: 'Contract',
				symbol: undefined,
				decimals: undefined,
				logoUri: undefined,
				entrySource: 'User',
				abi: undefined,
				useAsActiveAddress: undefined,
				declarativeNetRequestBlockMode: undefined,
				chainId: 1n,
			}
		})

		await updateModifyAddressWindowState(
			state,
			previousState => previousState,
			async () => {
				throw new Error('background unavailable')
			}
		)

		assert.deepEqual(state.value.errorState, {
			blockEditing: false,
			message: 'Failed to update address window state: background unavailable',
		})
	})

	test('renders Gnosis Safe signer controls as full-width editor rows', () => {
		assert.match(addNewAddressSource, /class = 'safe-signer-editor-title'><Text text = 'Gnosis Safe signers \(optional\)'\/>/)
		assert.match(addNewAddressSource, /class = 'safe-signer-editor-row'/)
		assert.match(addNewAddressSource, /type = 'radio'\s+name = 'active-safe-signer'/)
		assert.match(addNewAddressSource, /class = 'safe-signer-editor-add'/)
	})
})
