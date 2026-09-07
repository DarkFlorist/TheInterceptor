import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { WebsiteSocket } from '../utils/requests.js'
import { reportUnexpectedError } from '../utils/errors.js'

export type WebsiteLifecycleEvent =
	| { readonly type: 'approvalChanged', readonly socket: WebsiteSocket, readonly approved: boolean }
	| { readonly type: 'connectionRemoved', readonly socket: WebsiteSocket }
	| { readonly type: 'signerConnected', readonly socket: WebsiteSocket, readonly accountsRequested: boolean }
	| { readonly type: 'signerAccountsChanged', readonly socket: WebsiteSocket }
	| { readonly type: 'accessReconciled' }

type Listener = (event: WebsiteLifecycleEvent) => void
const listeners = new WeakMap<WebsiteTabConnections, Set<Listener>>()

export function subscribeWebsiteLifecycle(connections: WebsiteTabConnections, listener: Listener) {
	const subscribers = listeners.get(connections) ?? new Set<Listener>()
	subscribers.add(listener)
	listeners.set(connections, subscribers)
	return () => {
		subscribers.delete(listener)
		if (subscribers.size === 0) listeners.delete(connections)
	}
}

// Observers cannot delay or fail the core transition that publishes an event.
export function publishWebsiteLifecycle(connections: WebsiteTabConnections, event: WebsiteLifecycleEvent) {
	for (const listener of listeners.get(connections) ?? []) {
		try { listener(event) } catch (error) { void reportUnexpectedError(error) }
	}
}
