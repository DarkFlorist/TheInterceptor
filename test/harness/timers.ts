// Manual setTimeout and clearTimeout for tests that decide when pending timers fire instead of sleeping past their delay.
//
// Usage:
//   const timers = installManualTimers()
//   afterEach(timers.restore)                     // or restoreAfterTest(timers.restore) from perTest.ts
//   startCodeThatSchedulesARetry()
//   assert.equal(timers.pendingCount(), 1)
//   timers.runPending()                            // runs every timer pending right now, as if their delays had elapsed
//   const deadlineTimers = installManualTimers({ onlyDelayMs: 30 })   // holds back only 30 ms timers; other delays run normally
//
// The waiting helpers in async.ts keep the timer functions that existed when they loaded, so they still work while manual timers are installed.
import { replaceGlobal } from './globals.js'

export type ManualTimers = {
	// Number of scheduled callbacks that have not run or been cleared yet.
	readonly pendingCount: () => number
	// Runs the callbacks pending when it is called, in scheduling order; callbacks they schedule stay pending, and callbacks they clear do not run.
	readonly runPending: () => void
	// Puts back the setTimeout and clearTimeout that were installed before.
	readonly restore: () => void
}

export type ManualTimerOptions = {
	// Holds back only callbacks scheduled with exactly this delay; every other setTimeout call goes to the timer functions installed before.
	readonly onlyDelayMs?: number
}

export function installManualTimers({ onlyDelayMs }: ManualTimerOptions = {}): ManualTimers {
	const previousSetTimeout = globalThis.setTimeout
	const previousClearTimeout = globalThis.clearTimeout
	const pendingCallbacks = new Map<number, () => void>()
	let nextTimerId = 1
	const restoreSetTimeout = replaceGlobal('setTimeout', (callback: (...callbackArguments: unknown[]) => void, delay?: number, ...callbackArguments: unknown[]) => {
		if (onlyDelayMs !== undefined && delay !== onlyDelayMs) return previousSetTimeout(callback, delay, ...callbackArguments)
		const timerId = nextTimerId
		nextTimerId += 1
		pendingCallbacks.set(timerId, () => { callback(...callbackArguments) })
		return timerId
	})
	// Manual timer ids are numbers, while Bun's own timers are objects, so any other id belongs to a timer that was passed through. An id this mock handed out stays its own after the timer ran or was cleared, because Bun's clearTimeout also accepts numbers and the same number can name an unrelated Bun timer.
	const isManualTimerId = (timerId: unknown): timerId is number => typeof timerId === 'number' && timerId >= 1 && timerId < nextTimerId
	const restoreClearTimeout = replaceGlobal('clearTimeout', (timerId: Parameters<typeof clearTimeout>[0]) => {
		if (isManualTimerId(timerId)) {
			pendingCallbacks.delete(timerId)
			return
		}
		previousClearTimeout(timerId)
	})
	return {
		pendingCount: () => pendingCallbacks.size,
		runPending: () => {
			for (const timerId of [...pendingCallbacks.keys()]) {
				const callback = pendingCallbacks.get(timerId)
				if (callback === undefined) continue
				pendingCallbacks.delete(timerId)
				callback()
			}
		},
		restore: () => {
			restoreClearTimeout()
			restoreSetTimeout()
		},
	}
}
