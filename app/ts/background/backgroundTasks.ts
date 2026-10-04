import { reportUnexpectedError } from '../utils/errors.js'

const pendingTasks = new Set<Promise<void>>()

// Follow-up UI work owns its errors after the command has acknowledged its local change.
export function startBackgroundTask(task: () => Promise<unknown>) {
	const completion = Promise.resolve().then(task).then(() => undefined).catch(async (error: unknown) => {
		await reportUnexpectedError(error)
	}).finally(() => { pendingTasks.delete(completion) })
	pendingTasks.add(completion)
}

// Wait for follow-up work separately from command acknowledgement, including tasks started by other tasks.
export async function waitForBackgroundTasks() {
	while (pendingTasks.size > 0) await Promise.all([...pendingTasks])
}
