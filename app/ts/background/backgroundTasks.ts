import { reportUnexpectedError } from '../utils/errors.js'

// Follow-up UI work returns its own completion for durable error reporting; task tracking belongs to the caller lifecycle, separate from command acknowledgement.
export function startBackgroundTask(task: () => Promise<unknown>): Promise<void> {
	return Promise.resolve().then(task).then(() => undefined).catch(async (error: unknown) => {
		await reportUnexpectedError(error)
	})
}
