import { reportUnexpectedError } from '../utils/errors.js'

// Invoke the callback supplied by the caller's connection context; there is no registry or broadcast channel.
export function notifyWebsiteLifecycle<Args extends readonly unknown[]>(callback: ((...args: Args) => void | Promise<void>) | undefined, ...args: Args) {
	try {
		const pending = callback?.(...args)
		if (pending !== undefined) void pending.catch(async (error: unknown) => { await reportUnexpectedError(error) })
	} catch (error) { void reportUnexpectedError(error) }
}
