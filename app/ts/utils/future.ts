export class Future<T> implements PromiseLike<T> {
	private readonly promise: Promise<T>
	private resolveFunction: ((value: T | PromiseLike<T>) => void) | undefined = undefined
	private rejectFunction: ((reason: Error) => void) | undefined = undefined

	public constructor() {
		this.promise = new Promise<T>((resolve, reject) => {
			this.resolveFunction = resolve
			this.rejectFunction = reject
		})
	}

	public get asPromise() {
		return this.promise
	}

	public then<TResult1 = T, TResult2 = never>(
		onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
		onrejected?: ((reason: Error) => TResult2 | PromiseLike<TResult2>) | null,
	): PromiseLike<TResult1 | TResult2> {
		return this.promise.then(onfulfilled, onrejected)
	}

	public resolve(value: T | PromiseLike<T>) {
		if (this.resolveFunction === undefined) throw new Error('Future resolve function was not initialized')
		this.resolveFunction(value)
	}

	public reject(reason: Error) {
		if (this.rejectFunction === undefined) throw new Error('Future reject function was not initialized')
		this.rejectFunction(reason)
	}
}
