export class Future<T> implements PromiseLike<T> {
	private promise: Promise<T>
	private resolveFunction: (value: T | PromiseLike<T>) => void
	private rejectFunction: (reason: Error) => void

	constructor() {
		let resolveFunction: (value: T | PromiseLike<T>) => void
		let rejectFunction: (reason: Error) => void
		this.promise = new Promise((resolve: (value: T | PromiseLike<T>) => void, reject: (reason: Error) => void) => {
			resolveFunction = resolve
			rejectFunction = reject
		})
		// the function passed to the Promise constructor is called before the constructor returns, so we can be sure the resolve and reject functions have been set by here even if the compiler can't verify
		this.resolveFunction = resolveFunction!
		this.rejectFunction = rejectFunction!
	}

	public get asPromise() { return this.promise }

	public readonly then = <U>(
		onfulfilled?: ((value: T) => U | PromiseLike<U>) | undefined | null,
		onrejected?: ((reason: unknown) => U | PromiseLike<U>) | ((reason: unknown) => T | PromiseLike<T>) | undefined | null,
	): PromiseLike<T | U> => {
		if (onfulfilled === null || onfulfilled === undefined) {
			return this.promise.then(onfulfilled, onrejected as ((reason: unknown) => T | PromiseLike<T>) | null | undefined)
		} else {
			return this.promise.then(onfulfilled, onrejected as ((reason: unknown) => U | PromiseLike<U>) | null | undefined)
		}
	}
	public readonly resolve = (value: T | PromiseLike<T>) => this.resolveFunction!(value)
	public readonly reject = (reason: Error) => this.rejectFunction!(reason)
}

export type FutureUnion<TUnion> = TUnion extends any ? Future<TUnion> : never
