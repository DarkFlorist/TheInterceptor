import { clearTabStates } from './storageVariables.js'

export function initializeTabStateStorage(manifestVersion: number) {
	return manifestVersion === 2 ? clearTabStates() : Promise.resolve()
}

export function keepTabStateCleanupAlive(event: Event) {
	if (!('waitUntil' in event) || typeof event.waitUntil !== 'function') throw new Error('Service worker activation event is not extendable')
	event.waitUntil(clearTabStates())
}
