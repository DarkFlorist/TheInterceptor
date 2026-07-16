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
