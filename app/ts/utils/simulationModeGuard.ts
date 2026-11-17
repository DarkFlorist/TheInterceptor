// Forwarding and settings mutation run in the background context. UI contexts request changes through background messages; reading settings never repairs simulationMode.

// Counts completed writes that enable simulation mode. Only entering simulation mode can invalidate a decision to forward a request to the signer.
let simulationModeGeneration = 0
// Storage writes that enable simulation mode, including atomic imports, are tracked before the storage call starts.
const pendingSimulationModeEnablingWrites = new Set<Promise<void>>()
let enablingWriteCount = 0

// Every forward to the signer is checked with a guard captured where the forwarding decision starts: before the settings it is based on are read, and before the decision's first await.
export type SimulationModeGuard = {
	// False if simulation mode may have been enabled since the guard was captured: an enabling write is still in flight or one has completed since. Use it to refuse early; the forward itself is posted through postSignerForwardIfAllowed.
	readonly allowsSignerForward: () => boolean
	// Checks allowsSignerForward() and runs postForward in the same synchronous step, so no await can come between the check and the post. postForward must post the forward synchronously.
	readonly postSignerForwardIfAllowed: <Result>(postForward: () => Result) => { readonly posted: true, readonly result: Result } | { readonly posted: false }
}

function createSimulationModeGuard(allowsSignerForward: () => boolean): SimulationModeGuard {
	return {
		allowsSignerForward,
		postSignerForwardIfAllowed: (postForward) => allowsSignerForward() ? { posted: true, result: postForward() } : { posted: false },
	}
}

export function captureSimulationModeGuard(): SimulationModeGuard {
	const capturedGeneration = simulationModeGeneration
	return createSimulationModeGuard(() => enablingWriteCount === 0 && simulationModeGeneration === capturedGeneration)
}

// For resolving actions that never forward to the signer; if such a path ever did forward, this guard refuses it.
export const refuseSignerForwardGuard = createSimulationModeGuard(() => false)

export async function waitForSimulationModeEnablingWrites() {
	await Promise.allSettled(pendingSimulationModeEnablingWrites)
}

// The canonical setter uses this for mode switches and multi-key imports. Mark the write before invoking storage, while preserving storage-call order relative to subsequent writes that disable simulation mode.
export async function trackSimulationModeEnablingWrite(write: () => Promise<void>) {
	enablingWriteCount++
	try {
		const pendingWrite = write()
		pendingSimulationModeEnablingWrites.add(pendingWrite)
		try {
			await pendingWrite
		} finally {
			pendingSimulationModeEnablingWrites.delete(pendingWrite)
		}
	} finally {
		enablingWriteCount--
		// A failed write may already be visible in storage, so it also invalidates decisions captured before it started.
		simulationModeGeneration++
	}
}
