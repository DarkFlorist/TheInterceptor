import { Semaphore } from './semaphore.js'

type StoredValueRepositoryOptions<T> = {
	read: () => Promise<T | undefined>
	write: (value: T) => Promise<void>
	getDefault: () => T
	recover?: (error: unknown, defaultValue: T) => Promise<void>
}

export type StoredValueRepository<T> = {
	get: () => Promise<T>
	set: (value: T) => Promise<void>
	update: (updateValue: (previous: T) => T | Promise<T>) => Promise<{ previous: T, current: T }>
}

/** Owns the defaulting, corrupt-value recovery, and atomic update policy for one stored value. */
export function createStoredValueRepository<T>(options: StoredValueRepositoryOptions<T>): StoredValueRepository<T> {
	const updateSemaphore = new Semaphore(1)
	const get = async () => {
		try {
			return await options.read() ?? options.getDefault()
		} catch (error: unknown) {
			if (options.recover === undefined) throw error
			const defaultValue = options.getDefault()
			await options.recover(error, defaultValue)
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
