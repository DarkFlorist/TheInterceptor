import * as assert from 'node:assert'
import { test } from 'bun:test'
import './confirmTransactionTestHarness.js'
import { withPendingConfirmationLock } from '../../app/ts/background/confirmationWindowLifecycle.js'

test('admission releases its lock before awaited cleanup acquires it again', async () => {
	const events: string[] = []
	await withPendingConfirmationLock(async (admission) => {
		events.push('admission')
		admission.afterRelease(async () => await withPendingConfirmationLock(async () => { events.push('cleanup') }))
		events.push('registered')
	})
	assert.deepEqual(events, ['admission', 'registered', 'cleanup'])
}, 1_000)

test('failed admission still releases the lock before cleanup and preserves the failure', async () => {
	const failure = new Error('The confirmation could not be stored')
	let cleanupRan = false
	await assert.rejects(withPendingConfirmationLock(async (admission) => {
		admission.afterRelease(async () => await withPendingConfirmationLock(async () => { cleanupRan = true }))
		throw failure
	}), failure)
	assert.equal(cleanupRan, true)
}, 1_000)

test('an orphan snapshot cannot decline a replacement using the same page request id', async () => {
	const { modules, pendingTransaction, uniqueRequestIdentifier } = await import('./confirmTransactionTestHarness.js')
	const { getUniqueRequestIdentifierString } = await import('../../app/ts/utils/requests.js')
	const { recordResolutionInput, getPendingResolutionIdentity, writeInputsRecordedSoFar } = await import('../../app/ts/background/requestResolutionInputs.js')
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [{ ...pendingTransaction, transactionIdentifier: pendingTransaction.transactionIdentifier + 1n }] })
	recordResolutionInput(getUniqueRequestIdentifierString(uniqueRequestIdentifier), { kind: 'decline', reason: 'close' }, getPendingResolutionIdentity(pendingTransaction))
	await writeInputsRecordedSoFar(uniqueRequestIdentifier, async () => undefined)
	const [replacement] = await modules.getPendingTransactionsAndMessages()
	assert.ok(replacement)
	assert.equal(replacement.resolutionInputs, undefined)
})
