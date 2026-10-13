export class Future<T> implements PromiseLike<T> {
	private promise: Promise<T>
	private resolveFunction: (value: T | PromiseLike<T>) => void
	private rejectFunction: (reason: Error) => void

	constructor() {
		const promiseSettlers: { resolve?: (value: T | PromiseLike<T>) => void, reject?: (reason: Error) => void } = {}
		this.promise = new Promise((resolve: (value: T | PromiseLike<T>) => void, reject: (reason: Error) => void) => {
			promiseSettlers.resolve = resolve
			promiseSettlers.reject = reject
		})
		// The Promise constructor calls its executor before returning, so both settlers are set here even though the compiler cannot verify it.
		if (promiseSettlers.resolve === undefined || promiseSettlers.reject === undefined) throw new Error('Promise executor did not run synchronously')
		this.resolveFunction = promiseSettlers.resolve
		this.rejectFunction = promiseSettlers.reject
	}

	public get asPromise() { return this.promise }

	public readonly then = <TResult1 = T, TResult2 = never>(
		onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
		onrejected?: ((reason: Error) => TResult2 | PromiseLike<TResult2>) | null
	): PromiseLike<TResult1 | TResult2> => {
		return this.promise.then(onfulfilled, onrejected)
	}

	public readonly resolve = (value: T | PromiseLike<T>) => this.resolveFunction(value)
	public readonly reject = (reason: Error) => this.rejectFunction(reason)
}
