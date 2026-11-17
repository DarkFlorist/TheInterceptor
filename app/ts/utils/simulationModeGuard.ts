import { captureLocalStorageWritesTo } from './storageUtils.js'

const SIMULATION_MODE_CHANGE_WAIT_MS = 3_000

// Each forwarding decision gets a snapshot from the storage owner. Mode changes are requested through the background; UI reads never repair this key.
export type SimulationModeGuard = {
	readonly allowsSignerForward: () => boolean
	readonly postSignerForwardIfAllowed: <Result>(postForward: () => Result) => { readonly posted: true, readonly result: Result } | { readonly posted: false }
	readonly waitForPendingWrites: () => Promise<boolean>
}

function createSimulationModeGuard(allowsSignerForward: () => boolean, waitForPendingWrites: () => Promise<boolean>): SimulationModeGuard {
	return {
		allowsSignerForward,
		postSignerForwardIfAllowed: (postForward) => allowsSignerForward() ? { posted: true, result: postForward() } : { posted: false },
		waitForPendingWrites,
	}
}

export function captureSimulationModeGuard(): SimulationModeGuard {
	const writes = captureLocalStorageWritesTo('simulationMode', true)
	// Every signer forward depends on the one global mode. Only enabling writes block it; other settings and signing-mode writes remain independent. A request refuses after a bounded wait if an enabling write never settles.
	return createSimulationModeGuard(writes.isCurrent, async () => await writes.waitForPendingWrites(SIMULATION_MODE_CHANGE_WAIT_MS))
}

// Actions that cannot authorize a signer forward carry a permanently refusing capability.
export const refuseSignerForwardGuard = createSimulationModeGuard(() => false, async () => false)
