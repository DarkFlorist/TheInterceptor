import { Semaphore } from './semaphore.js'

// How to recover a stored value that cannot be used. The storage reader knows which of its read errors mean "the stored value is unusable", so it supplies that decision: such an error is passed to `recover` and the value then reads as the default. Any other read failure is rethrown, never recovered, so an update cannot write the default over records it failed to read.
export type StoredValueRecovery<T> = {
	isUnusableStoredValueError: (error: unknown) => boolean
	recover: (error: unknown, defaultValue: T) => Promise<void>
}

type StoredValueRepositoryOptions<T> = {
	read: () => Promise<T | undefined>
	write: (value: T) => Promise<void>
	getDefault: () => T
	recovery?: StoredValueRecovery<T>
}

export type StoredValueRepository<T> = {
	get: () => Promise<T>
	set: (value: T) => Promise<void>
	update: (updateValue: (previous: T) => T | Promise<T>) => Promise<{ previous: T, current: T }>
}

/** Owns the defaulting, unusable-value recovery, and atomic update policy for one stored value. Which read errors are recoverable is the reader's decision (see StoredValueRecovery). */
export function createStoredValueRepository<T>(options: StoredValueRepositoryOptions<T>): StoredValueRepository<T> {
	const updateSemaphore = new Semaphore(1)
	const get = async () => {
		try {
			return await options.read() ?? options.getDefault()
		} catch (error: unknown) {
			if (options.recovery === undefined || !options.recovery.isUnusableStoredValueError(error)) throw error
			const defaultValue = options.getDefault()
			await options.recovery.recover(error, defaultValue)
			return defaultValue
		}
	}
	const set = async (value: T) => await updateSemaphore.execute(async () => await options.write(value))
	const update = async (updateValue: (previous: T) => T | Promise<T>) => await updateSemaphore.execute(async () => {
		const previous = await get()
		const current = await updateValue(previous)
		await options.write(current)
		return { previous, current }
	})
	return { get, set, update }
}
