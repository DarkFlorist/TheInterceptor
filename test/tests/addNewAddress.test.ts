import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { saveAddressBookEntry } from '../../app/ts/components/pages/AddNewAddress.js'

const sampleAddressBookEntry = {
	type: 'contact',
	name: 'Alice',
	address: 1n,
	entrySource: 'User',
} as const

describe('add new address save flow', () => {
	test('waits for the save message to finish before closing the popup', async () => {
		const calls: string[] = []
		await saveAddressBookEntry(
			sampleAddressBookEntry,
			() => {
				calls.push('close')
			},
			async () => {
				calls.push('send:start')
				await Promise.resolve()
				calls.push('send:end')
			},
		)

		assert.deepEqual(calls, ['send:start', 'send:end', 'close'])
	})

	test('does not close the popup when the entry is invalid', async () => {
		let closed = false
		let sent = false

		await saveAddressBookEntry(
			{ type: 'error', error: 'invalid' },
			() => {
				closed = true
			},
			async () => {
				sent = true
			},
		)

		assert.equal(sent, false)
		assert.equal(closed, false)
	})
})
