import { reportLocalRecovery } from '../utils/errors.js'

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

// Each item of a recovery pass is its own step: one failing item (keeping its own retry state) never holds back the items after it. Returns the failures, in order.
export async function runEachIndependently<Item>(items: readonly Item[], run: (item: Item) => Promise<unknown>) {
	const failures: unknown[] = []
	for (const item of items) {
		try {
			await run(item)
		} catch (error: unknown) {
			failures.push(error)
		}
	}
	return failures
}

// The pass as a whole still fails, with its first failure, once every item ran; the other failures are reported so none goes unseen.
export async function surfaceIndependentFailures(failures: readonly unknown[]) {
	if (failures.length === 0) return
	for (const failure of failures.slice(1)) await reportLocalRecovery(failure, { code: 'pending_confirmation_recovery_item_failed', message: 'One item failed during recovery; the other items were still recovered.' })
	throw failures[0]
}
