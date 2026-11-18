import * as assert from 'assert'
import { describe, test } from 'bun:test'
import * as funtypes from 'funtypes'
import { createStoredValueRepository } from '../../app/ts/utils/storedValue.js'

describe('stored value repository', () => {
	test('propagates read failures unless recovery is explicitly configured', async () => {
		const readError = new Error('storage read failed')
		let writeCount = 0
		const repository = createStoredValueRepository({
			read: async () => { throw readError },
			write: async () => { writeCount += 1 },
			getDefault: () => 0,
		})

		await assert.rejects(repository.get(), (error: unknown) => error === readError)
		await assert.rejects(repository.update((previous) => previous + 1), (error: unknown) => error === readError)
		assert.equal(writeCount, 0)
	})

	test('returns the default only after configured recovery of an undecodable value completes', async () => {
		const calls: string[] = []
		const repository = createStoredValueRepository({
			// A stored value that no longer decodes, as the storage readers report it.
			read: async () => funtypes.Number.parse('corrupt value'),
			write: async (value: number) => { calls.push(`write:${ value }`) },
			getDefault: () => 4,
			recovery: {
				isUnusableStoredValueError: (error) => error instanceof funtypes.ValidationError,
				recover: async (error, defaultValue) => {
					assert.equal(error instanceof funtypes.ValidationError, true)
					calls.push(`recover:${ defaultValue }`)
				},
			},
		})

		assert.equal(await repository.get(), 4)
		assert.deepEqual(calls, ['recover:4'])
	})

	// The repository has no notion of a decoding library: a reader that validates differently, or wraps its decode error, recovers through its own predicate.
	test('recovers whatever read error the reader marks as an unusable stored value', async () => {
		const unreadableRecord = new Error('record has an unknown shape')
		const calls: string[] = []
		const repository = createStoredValueRepository({
			read: async () => { throw unreadableRecord },
			write: async (value: number) => { calls.push(`write:${ value }`) },
			getDefault: () => 7,
			recovery: {
				isUnusableStoredValueError: (error) => error === unreadableRecord,
				recover: async (_error, defaultValue) => { calls.push(`recover:${ defaultValue }`) },
			},
		})

		assert.equal(await repository.get(), 7)
		assert.deepEqual((await repository.update((previous) => previous + 1)).current, 8)
		assert.deepEqual(calls, ['recover:7', 'recover:7', 'write:8'])
	})

	// Recovery covers only the errors the reader marks as an unusable stored value: an update after a failed storage read must not write the default over records it could not read.
	test('rethrows a read error the reader does not mark as an unusable stored value', async () => {
		const readError = new Error('storage read failed')
		const calls: string[] = []
		const repository = createStoredValueRepository({
			read: async () => { throw readError },
			write: async (value: number) => { calls.push(`write:${ value }`) },
			getDefault: () => 4,
			recovery: {
				isUnusableStoredValueError: (error) => error instanceof funtypes.ValidationError,
				recover: async () => { calls.push('recover') },
			},
		})

		await assert.rejects(repository.get(), (error: unknown) => error === readError)
		await assert.rejects(repository.update((previous) => previous + 1), (error: unknown) => error === readError)
		assert.deepEqual(calls, [])
	})

	test('serializes direct writes behind an in-flight read-modify-write update', async () => {
		let storedValue = 1
		let releaseUpdate = () => undefined
		let signalUpdateStarted = () => undefined
		const updateStarted = new Promise<void>((resolve) => { signalUpdateStarted = resolve })
		const continueUpdate = new Promise<void>((resolve) => { releaseUpdate = resolve })
		const repository = createStoredValueRepository({
			read: async () => storedValue,
			write: async (value: number) => { storedValue = value },
			getDefault: () => 0,
		})

		const updatePromise = repository.update(async (previous) => {
			signalUpdateStarted()
			await continueUpdate
			return previous + 1
		})
		await updateStarted
		const setPromise = repository.set(10)
		releaseUpdate()
		await Promise.all([updatePromise, setPromise])

		assert.equal(storedValue, 10)
	})
})
