type RetryTimer = ReturnType<typeof setTimeout>

type BoundedRetryOptions = {
	readonly baseDelayMs: number
	readonly attemptLimit: number
	readonly scheduleRetry?: (retry: () => void, delayMs: number) => RetryTimer
}

/**
 * The one retry engine: per key, a budget of failed attempts and at most one scheduled retry, with backoff from baseDelayMs, doubling.
 * retryAfterFailure counts a failure and reserves the retry synchronously, before the failure is reported, so concurrent failures each count once and a timer is never overwritten without being cleared. Each schedule has its own generation: a reset or a newer failure replaces it, so a stale timer does nothing.
 */
export function createBoundedRetries<Key>({ baseDelayMs, attemptLimit, scheduleRetry = (retry, delayMs) => setTimeout(retry, delayMs) }: BoundedRetryOptions) {
	const retries = new Map<Key, { readonly failedAttempts: number, readonly generation: number, readonly timer?: RetryTimer }>()
	let nextGeneration = 0
	const reset = (key: Key) => {
		clearTimeout(retries.get(key)?.timer)
		retries.delete(key)
	}
	const retryAfterFailure = async (key: Key, retry: (generation: number) => void, report: (retrying: boolean) => unknown) => {
		const previous = retries.get(key)
		clearTimeout(previous?.timer)
		const failedAttempts = (previous?.failedAttempts ?? 0) + 1
		const retrying = failedAttempts < attemptLimit
		const generation = nextGeneration++
		retries.set(key, {
			failedAttempts,
			generation,
			...(!retrying ? {} : {
				timer: scheduleRetry(() => {
					if (retries.get(key)?.generation !== generation) return
					retries.set(key, { failedAttempts, generation })
					retry(generation)
				}, baseDelayMs * 2 ** (failedAttempts - 1)),
			}),
		})
		await report(retrying)
	}
	return {
		retryAfterFailure,
		reset,
		resetAll: () => { for (const key of [...retries.keys()]) reset(key) },
		getTrackedKeyCount: () => retries.size,
		budgetLasts: (key: Key) => (retries.get(key)?.failedAttempts ?? 0) < attemptLimit,
		isCurrent: (key: Key, generation: number) => retries.get(key)?.generation === generation,
		getScheduledRetryCount: () => [...retries.values()].filter((entry) => entry.timer !== undefined).length,
	}
}
