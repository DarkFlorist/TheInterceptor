// https://github.com/jsoendermann/semaphore-async-await/blob/master/src/Semaphore.ts
/** Semaphores are initialized with a number of permits that get aquired and released
 * over the lifecycle of the semaphore. These permits limit the number of simultaneous
 * executions of the code that the semaphore synchronizes. Functions can wait on a semaphore
 * and stop executing until a permit becomes available.
 *
 * Locks are a special case of semaphores that only allow one execution of a critical section.
 * If you need a lock, you can import the Lock class from this package.
 *
 * This Semaphore implementation uses plain closures and promises that get returned
 * by functions that wait for permits to become available. This makes it possible
 * to use async/await to synchronize your code.
 */
export interface Semaphore {
	getPermits(): number
	wait(): Promise<boolean>
	acquire(): Promise<boolean>
	waitFor(milliseconds: number): Promise<boolean>
	tryAcquire(): boolean
	drainPermits(): number
	signal(): void
	release(): void
	execute<T>(func: () => T | PromiseLike<T>): Promise<T>
}

export function Semaphore(initialPermits: number): Semaphore {
	let permits = initialPermits
	const promiseResolverQueue: Array<(value: boolean) => void> = []

	const getPermits = () => permits

	const wait = async (): Promise<boolean> => {
		if (permits > 0) {
			permits -= 1
			return true
		}

		return await new Promise<boolean>((resolve) => {
			promiseResolverQueue.push(resolve)
		})
	}

	const acquire = async () => await wait()

	const waitFor = async (milliseconds: number): Promise<boolean> => {
		if (permits > 0) {
			permits -= 1
			return true
		}

		return await new Promise<boolean>((resolve) => {
			let settled = false
			const resolver = (result: boolean) => {
				if (settled) return
				settled = true
				resolve(result)
			}

			promiseResolverQueue.push(resolver)

			setTimeout(() => {
				const index = promiseResolverQueue.indexOf(resolver)
				if (index === -1) return
				promiseResolverQueue.splice(index, 1)
				resolver(false)
			}, milliseconds)
		})
	}

	const tryAcquire = () => {
		if (permits > 0) {
			permits -= 1
			return true
		}

		return false
	}

	const drainPermits = () => {
		if (permits > 0) {
			const permitCount = permits
			permits = 0
			return permitCount
		}

		return 0
	}

	const signal = () => {
		permits += 1

		if (permits > 1 && promiseResolverQueue.length > 0) {
			console.warn('Semaphore.permits should never be > 0 when there is someone waiting.')
		} else if (permits === 1 && promiseResolverQueue.length > 0) {
			permits -= 1
			const nextResolver = promiseResolverQueue.shift()
			if (nextResolver !== undefined) nextResolver(true)
		}
	}

	const release = () => { signal() }

	const execute = async <T>(func: () => T | PromiseLike<T>): Promise<T> => {
		await wait()
		try {
			return await func()
		} finally {
			signal()
		}
	}

	return {
		getPermits,
		wait,
		acquire,
		waitFor,
		tryAcquire,
		drainPermits,
		signal,
		release,
		execute,
	}
}
