import { createBoundedRetries } from '../utils/boundedRetry.js'

type RecoveryTimer = ReturnType<typeof setTimeout>

type RetriableRecoveryOptions = {
	readonly recover: () => Promise<void>
	readonly onFailure: (error: unknown, retrying: boolean) => void
	readonly scheduleRetry?: (retry: () => void, delayMs: number) => RecoveryTimer
}

const RECOVERY_RETRY_BASE_DELAY_MS = 100
const RECOVERY_ATTEMPT_LIMIT = 6
const RECOVERY_RETRY_KEY = 'startup-recovery'

// Runs the startup recovery, retrying a failed pass with backoff (100 ms, doubling) up to a limit of attempts; onFailure tells whether another attempt follows, so the last failure is reported as giving up.
export function createRetriableTerminalStateRecovery({ recover, onFailure, scheduleRetry }: RetriableRecoveryOptions) {
	const retries = createBoundedRetries<string>({ baseDelayMs: RECOVERY_RETRY_BASE_DELAY_MS, attemptLimit: RECOVERY_ATTEMPT_LIMIT, ...(scheduleRetry === undefined ? {} : { scheduleRetry }) })
	const runRecovery = async (): Promise<void> => {
		try {
			await recover()
			retries.reset(RECOVERY_RETRY_KEY)
		} catch (error) {
			await retries.retryAfterFailure(RECOVERY_RETRY_KEY, () => { void runRecovery() }, (retrying) => onFailure(error, retrying))
		}
	}
	return runRecovery
}
