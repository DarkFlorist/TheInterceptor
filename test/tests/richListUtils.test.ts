import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { updateRichListAddress } from '../../app/ts/utils/richList.js'

type TestRichListElement = {
	address: bigint
	makingRich: boolean
	name: string
}

const getElementAddress = (element: TestRichListElement) => element.address
const createRichElement = (address: bigint, name = 'new'): TestRichListElement => ({ address, makingRich: true, name })

describe('rich list helpers', () => {
	test('appends a new rich address', () => {
		const existing = createRichElement(1n, 'existing')

		assert.deepStrictEqual(updateRichListAddress(
			[existing],
			2n,
			true,
			getElementAddress,
			() => createRichElement(2n),
		), [existing, createRichElement(2n)])
	})

	test('updates an existing address in place and removes duplicate entries', () => {
		const before = [
			{ address: 1n, makingRich: false, name: 'first' },
			createRichElement(2n, 'middle'),
			{ address: 1n, makingRich: false, name: 'duplicate' },
		]

		assert.deepStrictEqual(updateRichListAddress(
			before,
			1n,
			true,
			getElementAddress,
			() => createRichElement(1n, 'updated'),
		), [
			createRichElement(1n, 'updated'),
			createRichElement(2n, 'middle'),
		])
	})

	test('removes all matching entries when disabling an address', () => {
		const middle = createRichElement(2n, 'middle')

		assert.deepStrictEqual(updateRichListAddress(
			[
				createRichElement(1n, 'first'),
				middle,
				createRichElement(1n, 'duplicate'),
			],
			1n,
			false,
			getElementAddress,
			() => createRichElement(1n, 'unused'),
		), [middle])
	})
})
