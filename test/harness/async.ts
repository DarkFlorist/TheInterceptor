// Waiting helpers that replace fixed sleeps in bun tests.
//
// Usage:
//   await flushMicrotasks()                                            // let queued promise callbacks (and the ones they queue) run
//   await waitFor(() => browserMock.calls.runtimeSendMessage.length === 2)   // poll a condition instead of sleeping for a guessed duration
//   const reply = await waitForValue(() => replies.find(isHomeUpdate), { description: 'home page update' })
//   const result = await settleWithin(handleRequest(), 100, 'handleRequest deadlocked')   // fail fast instead of hanging when a promise never settles
//
// For a promise that a test resolves manually, use the built-in Promise.withResolvers<T>() instead of a local deferred helper. The helpers keep the timer functions that existed when this module loaded, so tests that replace setTimeout or Date cannot stall them.

const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
const realSetImmediate = globalThis.setImmediate
const realNow = performance.now.bind(performance)

export type WaitOptions = {
	readonly timeoutMs?: number
	readonly intervalMs?: number
	readonly description?: string
}

// Resolves after every microtask queued so far, including microtasks queued while those run, because a macrotask only starts once the microtask queue is empty.
export async function flushMicrotasks() {
	await new Promise<void>((resolve) => { realSetImmediate(resolve) })
}

const sleep = async (milliseconds: number) => await new Promise<void>((resolve) => { realSetTimeout(resolve, milliseconds) })

// Polls read() until it returns a value other than undefined; errors thrown by read() fail the wait immediately. The deadline also bounds each read, so an asynchronous read that never settles fails the wait instead of hanging until the test timeout.
export async function waitForValue<T>(read: () => T | undefined | Promise<T | undefined>, { timeoutMs = 1000, intervalMs = 5, description = 'condition' }: WaitOptions = {}): Promise<T> {
	const deadline = realNow() + timeoutMs
	const timeoutMessage = `Timed out after ${ timeoutMs } ms waiting for ${ description }`
	// Only a read that finishes by the deadline counts: the deadline cuts off an asynchronous read, and the value of a synchronous read that runs past it is not accepted.
	const readBeforeDeadline = async () => {
		const value = await settleWithin(Promise.resolve(read()), Math.max(0, deadline - realNow()), timeoutMessage)
		if (realNow() > deadline) throw new Error(timeoutMessage)
		return value
	}
	let value = await readBeforeDeadline()
	while (value === undefined) {
		// The last sleep ends at the deadline, so a polling interval longer than the time left cannot stretch the wait.
		await sleep(Math.min(intervalMs, Math.max(0, deadline - realNow())))
		value = await readBeforeDeadline()
	}
	return value
}

// Polls condition() until it returns true; errors thrown by condition() fail the wait immediately.
export async function waitFor(condition: () => boolean | Promise<boolean>, options: WaitOptions = {}) {
	await waitForValue(async () => await condition() ? true : undefined, options)
}

// Settles like promise, but rejects with failureMessage if promise is still pending after timeoutMs, so a deadlock fails the test quickly instead of hanging it.
export async function settleWithin<T>(promise: Promise<T>, timeoutMs: number, failureMessage: string): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined
	const deadline = new Promise<never>((_resolve, reject) => {
		timeout = realSetTimeout(() => { reject(new Error(failureMessage)) }, timeoutMs)
	})
	try {
		return await Promise.race([promise, deadline])
	} finally {
		realClearTimeout(timeout)
	}
}
