// https://github.com/jsoendermann/semaphore-async-await/blob/master/src/Semaphore.ts
/** Semaphores are initialized with a number of permits that get aquired and released
 * over the lifecycle of the semaphore. These permits limit the number of simultaneous
 * executions of the code that the semaphore synchronizes. Functions can wait on a semaphore
 * and stop executing until a permit becomes available.
 *
 * Locks are a special case of semaphores that only allow one execution of a critical section.
 * If you need a lock, you can import the Lock class from this package.
 *
 * This Semaphore class is implemented with the help of promises that get returned
 * by functions that wait for permits to become available. This makes it possible
 * to use async/await to synchronize your code.
 */
export class Semaphore {
	private permits: number
	private promiseResolverQueue: Array<(v: boolean) => void> = []

	/**
	 * Creates a semaphore.
	 * @param permits The number of permits, i.e. strands of execution being allowed to run in parallel. This number can be initialized with a negative integer.
	 */
	constructor(permits: number) {
		this.permits = permits
	}

	/**
	 * Returns the number of available permits.
	 * @returns The number of available permits.
	 */
	public getPermits(): number {
		return this.permits
	}

	/**
	 * Returns a promise used to wait for a permit to become available. This method should be awaited on.
	 * @returns A promise that gets resolved when execution is allowed to proceed.
	 */
	public async wait(): Promise<boolean> {
		if (this.permits > 0) {
			this.permits -= 1
			return Promise.resolve(true)
		}

		// If there is no permit available, we return a promise that resolves once the semaphore gets signaled enough times that permits is equal to one.
		return new Promise<boolean>(resolver => this.promiseResolverQueue.push(resolver))
	}

	/**
	 * Alias for {@linkcode Semaphore.wait}.
	 * @returns  A promise that gets resolved when execution is allowed to proceed.
	 */
	public async acquire(): Promise<boolean> {
		return this.wait()
	}

	/**
	 * Same as {@linkcode Semaphore.wait} except the promise returned gets resolved with false if no permit becomes available in time.
	 * @param milliseconds  The time spent waiting before the wait is aborted. This is a lower bound, you shouldn't rely on it being precise.
	 * @returns A promise that gets resolved to true when execution is allowed to proceed or false if the time given elapses before a permit becomes available.
	 */
	public async waitFor(milliseconds: number): Promise<boolean> {
		if (this.permits > 0) {
			this.permits -= 1
			return Promise.resolve(true)
		}

		// We save the resolver function in the current scope so that we can resolve the promise to false if the time expires.
		let resolver: (result: boolean) => void
		const promise = new Promise<boolean>(resolve => { resolver = resolve })

		// The saved resolver gets added to our list of promise resolvers so that it gets a chance to be resolved as a result of a call to signal().
		this.promiseResolverQueue.push(resolver!)

		setTimeout(() => {
			// We have to remove the promise resolver from our list. Resolving it twice would not be an issue but signal() always takes the next resolver from the queue and resolves it which would swallow a permit if we didn't remove it.
			const index = this.promiseResolverQueue.indexOf(resolver)
			if (index !== -1) {
				this.promiseResolverQueue.splice(index, 1)
			} else {
				// This shouldn't happen, not much we can do at this point
				console.warn('Semaphore.waitFor couldn\'t find its promise resolver in the queue')
			}

			// false because the wait was unsuccessful.
			resolver(false)
		}, milliseconds)

		return promise
	}

	/**
	 * Synchronous function that tries to acquire a permit and returns true if successful, false otherwise.
	 * @returns Whether a permit could be acquired.
	 */
	public tryAcquire(): boolean {
		if (this.permits > 0) {
			this.permits -= 1
			return true
		}

		return false
	}

	/**
	 * Acquires all permits that are currently available and returns the number of acquired permits.
	 * @returns Number of acquired permits.
	 */
	public drainPermits(): number {
		if (this.permits > 0) {
			const permitCount = this.permits
			this.permits = 0
			return permitCount
		}

		return 0
	}

	/**
	 * Increases the number of permits by one. If there are other functions waiting, one of them will continue to execute in a future iteration of the event loop.
	 */
	public signal(): void {
		this.permits += 1

		if (this.permits > 1 && this.promiseResolverQueue.length > 0) {
			console.warn('Semaphore.permits should never be > 0 when there is someone waiting.')
		} else if (this.permits === 1 && this.promiseResolverQueue.length > 0) {
			// If there is someone else waiting, immediately consume the permit that was released  at the beginning of this function and let the waiting function resume.
			this.permits -= 1

			const nextResolver = this.promiseResolverQueue.shift()
			if (nextResolver) {
				nextResolver(true)
			}
		}
	}

	/**
	 * Alias for {@linkcode Semaphore.signal}.
	 */
	public release(): void {
		this.signal()
	}

	/**
	 * Schedules func to be called once a permit becomes available.
	 * Returns a promise that resolves to the return value of func.
	 * @typeparam T The return type of func.
	 * @param func The function to be executed.
	 * @return A promise that gets resolved with the return value of the function.
	 */
	public async execute<T>(func: () => T | PromiseLike<T>): Promise<T> {
		await this.wait()
		try {
			return await func()
		} finally {
			this.signal()
		}
	}
}
