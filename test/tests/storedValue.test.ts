import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { createStoredValueRepository } from '../../app/ts/utils/storedValue.js'

describe('stored value repository', () => {
	test('propagates read failures without writing defaults', async () => {
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
