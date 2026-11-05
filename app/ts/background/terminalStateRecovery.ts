import { type FailureReportingLevel, reportLocalRecovery } from '../utils/errors.js'

type RecoveryTimer = ReturnType<typeof setTimeout>

type RetriableRecoveryOptions = {
	readonly recover: () => Promise<void>
	readonly onFailure: (error: unknown) => void
	readonly scheduleRetry?: (retry: () => void) => RecoveryTimer
}

export function createRetriableTerminalStateRecovery({ recover, onFailure, scheduleRetry = (retry) => setTimeout(retry, 100) }: RetriableRecoveryOptions) {
	let retryTimer: RecoveryTimer | undefined
	const runRecovery = async (): Promise<void> => {
		try {
			await recover()
		} catch (error) {
			onFailure(error)
			if (retryTimer !== undefined) return
			retryTimer = scheduleRetry(() => {
				retryTimer = undefined
				void runRecovery()
			})
		}
	}
	return runRecovery
}

// A recovery pass still fails, with its first failure, once every item ran; its other failures are reported at this level so none goes unseen.
export const reportRecoveryItemFailure: FailureReportingLevel = async (failure) => await reportLocalRecovery(failure, { code: 'pending_confirmation_recovery_item_failed', message: 'One item failed during recovery; the other items were still recovered.' })
