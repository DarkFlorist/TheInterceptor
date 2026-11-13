import { reportUnexpectedError } from '../utils/errors.js'

type BackgroundTaskContext = { readonly source: string, readonly details?: unknown }
export type BackgroundTaskOutcome = { readonly status: 'completed' } | { readonly status: 'failed', readonly error: unknown }

// The background supervisor owns task lifetime and attributes failures separately from acknowledged local commands.
export function createBackgroundTaskSupervisor(reportError = reportUnexpectedError) {
	let nextTaskId = 0
	const pending = new Map<number, { readonly context: BackgroundTaskContext, readonly completion: Promise<BackgroundTaskOutcome> }>()
	const getPendingTasks = () => [...pending].map(([taskId, { context }]) => ({ taskId, ...context }))
	return {
		getPendingTasks,
		start(context: BackgroundTaskContext, task: () => Promise<unknown>): Promise<BackgroundTaskOutcome> {
			const taskId = ++nextTaskId
			const completion = Promise.resolve().then(task).then(() => ({ status: 'completed' as const })).catch(async (error: unknown) => {
				await reportError(error, {
					source: context.source,
					code: 'background_ui_task_failed',
					details: { taskId, task: context.details, pendingTasks: getPendingTasks() },
				})
				return { status: 'failed' as const, error }
			}).finally(() => { pending.delete(taskId) })
			pending.set(taskId, { context, completion })
			return completion
		},
		async waitForIdle() {
			while (pending.size > 0) await Promise.all([...pending.values()].map(task => task.completion))
		},
	}
}

// One owner for UI follow-ups in this background execution context; callers can observe or await its real completions.
export const backgroundTaskSupervisor = createBackgroundTaskSupervisor()
