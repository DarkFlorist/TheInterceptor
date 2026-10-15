import { mock } from 'bun:test'
import { startBackgroundTask } from '../../app/ts/background/backgroundTasks.js'

// Keep test teardown bookkeeping out of the production background process.
const runBackgroundTask = startBackgroundTask
const pendingTasks = new Set<Promise<void>>()
mock.module('../../app/ts/background/backgroundTasks.js', () => ({
	startBackgroundTask: (task: () => Promise<unknown>) => {
		const completion = runBackgroundTask(task).finally(() => { pendingTasks.delete(completion) })
		pendingTasks.add(completion)
		return completion
	},
}))

export async function waitForBackgroundTasks() {
	while (pendingTasks.size > 0) await Promise.all([...pendingTasks])
}
