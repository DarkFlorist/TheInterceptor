import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { getNextGasLimitDraft } from '../../app/ts/utils/gasLimitDraft.js'

describe('gas limit draft', () => {
	test('follows a new estimate for the same transaction while the user has not edited the field', () => {
		assert.equal(getNextGasLimitDraft({ transactionIdentifier: 1n, gasLimit: 21_000n }, 21_000n, { transactionIdentifier: 1n, gasLimit: 23_000n }), 23_000n)
	})

	test('keeps an unsaved edit when a re-simulation estimates the same transaction again', () => {
		assert.equal(getNextGasLimitDraft({ transactionIdentifier: 1n, gasLimit: 21_000n }, 50_000n, { transactionIdentifier: 1n, gasLimit: 23_000n }), 50_000n)
	})

	test('starts another transaction from its own gas limit, even when both limits are equal', () => {
		assert.equal(getNextGasLimitDraft({ transactionIdentifier: 1n, gasLimit: 21_000n }, 50_000n, { transactionIdentifier: 2n, gasLimit: 21_000n }), 21_000n)
	})

	test('shows the saved limit after the user changes it', () => {
		// Saving stores the draft as the transaction's gas limit, which then arrives as the new limit.
		assert.equal(getNextGasLimitDraft({ transactionIdentifier: 1n, gasLimit: 21_000n }, 50_000n, { transactionIdentifier: 1n, gasLimit: 50_000n }), 50_000n)
	})
})
