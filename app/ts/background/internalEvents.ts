import { InternalMessage } from '../messages/internal.js'

type InternalListener = (message: InternalMessage) => void

const listeners = new Set<InternalListener>()

export function emitInternalMessage(message: InternalMessage) {
	for (const listener of listeners) {
		listener(message)
	}
}

export function addInternalMessageListener(listener: InternalListener) {
	listeners.add(listener)
	return () => listeners.delete(listener)
}

export function waitForInternalMessage(predicate: (message: InternalMessage) => boolean) {
	return new Promise<void>((resolve) => {
		const remove = addInternalMessageListener((message) => {
			if (!predicate(message)) return
			remove()
			resolve()
		})
	})
}
