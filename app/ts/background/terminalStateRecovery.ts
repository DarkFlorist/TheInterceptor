import { createBackoffRetryScheduler } from '../utils/retryScheduler.js'

type RecoveryTimer = ReturnType<typeof setTimeout>

type RetriableRecoveryOptions = {
	readonly recover: () => Promise<void>
	readonly onFailure: (error: unknown) => void
	readonly scheduleRetry?: (retry: () => void, delayMs: number) => RecoveryTimer
}

export function createRetriableTerminalStateRecovery({ recover, onFailure, scheduleRetry }: RetriableRecoveryOptions) {
	const retry = createBackoffRetryScheduler(100, scheduleRetry)
	let running: Promise<void> | undefined
	const runRecovery = (): Promise<void> => {
		if (running !== undefined) return running
		running = Promise.resolve().then(async () => {
			try {
				await recover()
				retry.reset()
			} catch (error) {
				onFailure(error)
				retry.schedule(() => { void runRecovery() })
			} finally {
				running = undefined
			}
		})
		return running
	}
	return runRecovery
}
