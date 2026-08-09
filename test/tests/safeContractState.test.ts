import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { handleSafeContractSnapshotFailure } from '../../app/ts/background/safeContractState.js'
import { NEW_BLOCK_ABORT } from '../../app/ts/utils/constants.js'

describe('Safe contract state error boundary', () => {
	test('returns a user-facing failure for expected infrastructure errors', async () => {
		let reportCount = 0
		const failure = new Error(NEW_BLOCK_ABORT)
		const result = await handleSafeContractSnapshotFailure(failure, async () => {
			reportCount += 1
		})

		assert.deepEqual(result, { ok: false, message: NEW_BLOCK_ABORT })
		assert.equal(reportCount, 0)
	})

	test('reports and rethrows unexpected snapshot failures', async () => {
		const failure = new Error('Safe owner decoder failed')
		let reportedError: unknown
		let reportedCode: string | undefined

		await assert.rejects(
			async () => await handleSafeContractSnapshotFailure(failure, async (error, metadata) => {
				reportedError = error
				reportedCode = metadata.code
			}),
			(error) => error === failure,
		)
		assert.equal(reportedError, failure)
		assert.equal(reportedCode, 'safe_contract_state_retrieval_failed')
	})
})
