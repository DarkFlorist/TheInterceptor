type RecoveryTimer = ReturnType<typeof setTimeout>

type RetriableRecoveryOptions = {
	readonly recover: () => Promise<void>
	readonly onFailure: (error: unknown, retrying: boolean) => void
	readonly scheduleRetry?: (retry: () => void, delayMs: number) => RecoveryTimer
}

const RECOVERY_RETRY_BASE_DELAY_MS = 100
const RECOVERY_ATTEMPT_LIMIT = 6

// Runs the startup recovery, retrying a failed pass with backoff (100 ms, doubling) up to a limit of attempts; onFailure tells whether another attempt follows, so the last failure is reported as giving up.
export function createRetriableTerminalStateRecovery({ recover, onFailure, scheduleRetry = (retry, delayMs) => setTimeout(retry, delayMs) }: RetriableRecoveryOptions) {
	let retryTimer: RecoveryTimer | undefined
	let failedAttempts = 0
	const runRecovery = async (): Promise<void> => {
		try {
			await recover()
			failedAttempts = 0
		} catch (error) {
			failedAttempts += 1
			const retrying = failedAttempts < RECOVERY_ATTEMPT_LIMIT
			// The retry is reserved before the failure is reported.
			if (retrying && retryTimer === undefined) retryTimer = scheduleRetry(() => {
				retryTimer = undefined
				void runRecovery()
			}, RECOVERY_RETRY_BASE_DELAY_MS * 2 ** (failedAttempts - 1))
			onFailure(error, retrying)
		}
	}
	return runRecovery
}
