type RetryTimer = ReturnType<typeof setTimeout>
type ScheduleRetry = (retry: () => void, delayMs: number) => RetryTimer

const MAX_RECOVERY_RETRY_DELAY_MS = 5_000

// Keep transient recovery fast and limit persistent failures to one retry every five seconds (formerly every 50–100 ms).
export function createBackoffRetryScheduler(initialDelayMs: number, scheduleRetry: ScheduleRetry = (retry, delayMs) => setTimeout(retry, delayMs)) {
	let timer: RetryTimer | undefined
	let nextDelayMs = initialDelayMs
	let generation = 0
	const reset = () => {
		if (timer !== undefined) clearTimeout(timer)
		timer = undefined
		nextDelayMs = initialDelayMs
		generation += 1
	}
	const schedule = (retry: () => void) => {
		if (timer !== undefined) return
		const scheduledGeneration = ++generation
		timer = scheduleRetry(() => {
			// An already queued callback must not restart recovery after reset or consume a newer retry.
			if (scheduledGeneration !== generation) return
			timer = undefined
			retry()
		}, nextDelayMs)
		nextDelayMs = Math.min(nextDelayMs * 2, MAX_RECOVERY_RETRY_DELAY_MS)
	}
	return { schedule, reset }
}
