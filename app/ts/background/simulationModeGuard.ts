import * as funtypes from 'funtypes'
import { RpcNetwork } from '../types/rpc.js'
import { SigningAddressPreferences } from '../types/signerTypes.js'
import { type EthereumAddress, serialize } from '../types/wire-types.js'
import { presenceAwareOptionalAddress } from '../utils/storageUtils.js'

// Guard state is per JS context and sees only the writes made in that context, so simulation mode is switched only from the background context that forwards to the signer.

export type SimulationModeChanges = {
	readonly simulationMode: boolean
	readonly rpcNetwork?: RpcNetwork
	readonly activeSimulationAddress?: EthereumAddress
	readonly activeSigningAddress?: EthereumAddress
	readonly activeSigningSafeAddress?: EthereumAddress
}

type SimulationModeWriteOtherItems = { readonly signingAddressPreferences?: SigningAddressPreferences }

// Only the keys this module writes, built from the same field definitions as storageUtils.ts so they are stored identically, which keeps a serializer that accepts simulationMode private to this module.
const SimulationModeStorageItems = funtypes.Intersect(
	funtypes.ReadonlyObject({ simulationMode: funtypes.Boolean }),
	funtypes.ReadonlyPartial({ activeRpcNetwork: RpcNetwork, signingAddressPreferences: SigningAddressPreferences }),
	presenceAwareOptionalAddress('independentActiveSimulationAddress'),
	presenceAwareOptionalAddress('activeSigningAddress'),
	presenceAwareOptionalAddress('activeSigningSafeAddress'),
)

function getSimulationModeStorageUpdate(changes: SimulationModeChanges) {
	return {
		simulationMode: changes.simulationMode,
		...changes.rpcNetwork ? { activeRpcNetwork: changes.rpcNetwork }: {},
		...'activeSimulationAddress' in changes ? { independentActiveSimulationAddress: changes.activeSimulationAddress } : {},
		...'activeSigningAddress' in changes ? { activeSigningAddress: changes.activeSigningAddress }: {},
		...'activeSigningSafeAddress' in changes ? { activeSigningSafeAddress: changes.activeSigningSafeAddress }: {},
	}
}

// Counts completed writes that enable simulation mode. Only entering simulation mode can invalidate a decision to forward a request to the signer.
let simulationModeGeneration = 0
// Enabling writes that have started but not settled; storage may already hold simulationMode: true while one is pending.
const pendingSimulationModeEnablingWrites = new Set<Promise<void>>()

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
	return createSimulationModeGuard(() => pendingSimulationModeEnablingWrites.size === 0 && simulationModeGeneration === capturedGeneration)
}

// For resolving actions that never forward to the signer; if such a path ever did forward, this guard refuses it.
export const refuseSignerForwardGuard = createSimulationModeGuard(() => false)

export async function waitForSimulationModeEnablingWrites() {
	await Promise.allSettled(pendingSimulationModeEnablingWrites)
}

// Private so that the module system keeps writeSimulationModeChanges the single writer: browserStorageLocalSet cannot write simulationMode, and this is the only call that does.
async function setSimulationModeInStorage(changes: SimulationModeChanges, otherItems: SimulationModeWriteOtherItems) {
	return await browser.storage.local.set(serialize(SimulationModeStorageItems, { ...getSimulationModeStorageUpdate(changes), ...otherItems }))
}

// The only writer of simulationMode, so the guard above sees every switch into simulation mode.
export async function writeSimulationModeChanges(changes: SimulationModeChanges, otherItems: SimulationModeWriteOtherItems = {}) {
	const write = setSimulationModeInStorage(changes, otherItems)
	if (!changes.simulationMode) return await write
	// Registered in the same synchronous step that starts the write, so no forward can be committed in between.
	pendingSimulationModeEnablingWrites.add(write)
	try {
		await write
	} finally {
		pendingSimulationModeEnablingWrites.delete(write)
		// Bump on settle so a decision that captured the old generation still sees the change after the write is no longer pending.
		simulationModeGeneration++
	}
}

export async function changeSimulationMode(changes: SimulationModeChanges) {
	return await writeSimulationModeChanges(changes)
}
