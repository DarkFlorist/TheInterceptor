import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { reportUnexpectedError } from '../utils/errors.js'

// Invoke the callback supplied by the caller's connection context; there is no registry or broadcast channel.
export function notifyWebsiteLifecycle<Args extends readonly unknown[]>(callback: ((...args: Args) => void | Promise<void>) | undefined, ...args: Args) {
	try {
		const pending = callback?.(...args)
		if (pending !== undefined) void pending.catch(async (error: unknown) => { await reportUnexpectedError(error) })
	} catch (error) { void reportUnexpectedError(error) }
}

// Readiness observers compose on this connection context's callback, with no separate event registry.
export function observeWebsiteSessionChanges(connections: WebsiteTabConnections, observer: () => void): () => void {
	const current = connections.lifecycle?.sessionChanged
	if (current?.observe !== undefined) return current.observe(observer)
	const observers: (() => void)[] = []
	const dispatch = Object.assign(() => {
		notifyWebsiteLifecycle(current)
		for (const callback of [...observers]) notifyWebsiteLifecycle(callback)
	}, { observe: (callback: () => void) => {
		observers.push(callback)
		return () => {
			const index = observers.indexOf(callback)
			if (index >= 0) observers.splice(index, 1)
			if (observers.length === 0 && connections.lifecycle?.sessionChanged === dispatch) connections.lifecycle = { ...connections.lifecycle, sessionChanged: current }
		}
	} })
	connections.lifecycle = { ...connections.lifecycle, sessionChanged: dispatch }
	return dispatch.observe(observer)
}
