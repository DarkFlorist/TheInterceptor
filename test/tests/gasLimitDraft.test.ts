import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { getNextGasLimitDraft } from '../../app/ts/utils/gasLimitDraft.js'

describe('gas limit draft', () => {
	test('follows estimates while unedited', () => {
		assert.deepEqual(getNextGasLimitDraft({ transactionIdentifier: 1n, gasLimit: 21_000n, wasEdited: false }, { transactionIdentifier: 1n, gasLimit: 23_000n }), { transactionIdentifier: 1n, gasLimit: 23_000n, wasEdited: false })
	})

	test('keeps an edit across an estimate that coincidentally matches it', () => {
		const typed = { transactionIdentifier: 1n, gasLimit: 50_000n, wasEdited: true }
		const coincidentEstimate = getNextGasLimitDraft(typed, { transactionIdentifier: 1n, gasLimit: 50_000n })
		assert.deepEqual(getNextGasLimitDraft(coincidentEstimate, { transactionIdentifier: 1n, gasLimit: 60_000n }), typed)
	})

	test('keeps an edited empty field through re-simulation', () => {
		assert.deepEqual(getNextGasLimitDraft({ transactionIdentifier: 1n, gasLimit: undefined, wasEdited: true }, { transactionIdentifier: 1n, gasLimit: 23_000n }), { transactionIdentifier: 1n, gasLimit: undefined, wasEdited: true })
	})

	test('starts another transaction unedited from its own limit, even when both limits are equal', () => {
		assert.deepEqual(getNextGasLimitDraft({ transactionIdentifier: 1n, gasLimit: 50_000n, wasEdited: true }, { transactionIdentifier: 2n, gasLimit: 50_000n }), { transactionIdentifier: 2n, gasLimit: 50_000n, wasEdited: false })
	})
})
