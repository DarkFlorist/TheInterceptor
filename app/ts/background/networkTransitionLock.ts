import { Semaphore } from '../utils/semaphore.js'
import { getErrorMessage } from '../utils/errors.js'
import { getActiveStackContext } from '../utils/activeStackContext.js'
import type { Settings } from '../types/interceptor-messages.js'
import type { InterceptorTransactionStack } from '../types/visualizer-types.js'
import type { SimulationServicesOwner } from '../simulation/serviceLifecycle.js'
import { getSettings } from './settings.js'
import { getInterceptorTransactionStack } from './storageVariables.js'
import { getCommittedNetworkChangeGeneration } from './networkChangeGeneration.js'
import { buildSimulationStateInput, readSimulationInputSources, type NetworkSnapshot, type NetworkState, type SimulationSnapshot, type SimulationSnapshotSources } from './simulationUpdating.js'

// The lock that every writer of the active network or of the installed services runs in, and the only place network snapshots are built. networkTransition.ts runs network changes in this lock and leaves here the repair of a change that failed part-way, as a callback, so this module imports neither the transition module nor the popup visualisation layer. The visualisation layer reads network state through this module: networkTransition.ts publishes to that layer, so importing it there would make the modules import each other.

const networkTransitionSemaphore = new Semaphore(1)

// Completes the effects that a failed transition could not complete. They belong to the lock rather than to a call chain: the failed transition has already thrown to its caller, so the next lock holder, a read included, completes them before it acts on the committed network. Reads run the repair too because the settings of the new network are already committed: there is no pre-transition state left to return, and a read that skipped the repair could pair the new settings with the previous network's services or stack. They live in memory only, so after a background restart services are rebuilt from the settings and websites receive the chain when they reconnect, but a stack left from the previous chain is not cleared.
let unfinishedNetworkChangeRepair: (() => Promise<void>) | undefined

// Called under the lock by a transition that committed a network change and then failed. The repair must be safe to retry: it stays recorded until it succeeds.
export function recordUnfinishedNetworkChange(repair: () => Promise<void>) {
	unfinishedNetworkChangeRepair = repair
}

// Runs under the lock. While the repair still fails it stays recorded and this throws, so no lock holder proceeds on a network whose effects are incomplete.
export async function completeUnfinishedNetworkChange() {
	const repair = unfinishedNetworkChangeRepair
	if (repair === undefined) return
	await repair()
	unfinishedNetworkChangeRepair = undefined
}

// A lock holder that finds the repair still failing rejects with an error that names the unfinished network change, rather than with the bare failure of a write it did not make.
async function completeUnfinishedNetworkChangeForLockHolder() {
	try {
		await completeUnfinishedNetworkChange()
	} catch (error: unknown) {
		throw new Error(`An earlier network change committed its settings but could not finish applying them, so the network cannot be read or changed until it does: ${ getErrorMessage(error) ?? 'unknown error' }`)
	}
}

// Stamps the committed network change generation onto the settings, sources and stack it is given. Only lock holders build snapshots, so no network change commits between reading those and stamping the generation.
function buildSimulationSnapshot(settings: Settings, sources: SimulationSnapshotSources, interceptorTransactionStack: InterceptorTransactionStack): SimulationSnapshot {
	return {
		activeRpcNetwork: settings.activeRpcNetwork,
		activeStackContext: getActiveStackContext(settings),
		simulationStateInput: buildSimulationStateInput(settings, sources, interceptorTransactionStack),
		numberOfAddressesMadeRich: sources.richAddresses.length,
		activeAddressMadeRich: sources.activeAddressMadeRich,
		interceptorTransactionStack,
		networkChangeGeneration: getCommittedNetworkChangeGeneration(),
	}
}

// Reads the settings and the stack built on them. An unreadable stack aborts before anything is published.
async function captureNetworkState(): Promise<NetworkState> {
	const settings = await getSettings()
	const sources = await readSimulationInputSources(settings)
	return { settings, simulation: buildSimulationSnapshot(settings, sources, await getInterceptorTransactionStack()) }
}

// The snapshot builders, handed only to tasks that hold the lock: they read storage without taking it, so outside the lock they could pair one network's settings or stack with a later network's generation.
export type LockedNetworkReads = {
	readonly captureNetworkState: () => Promise<NetworkState>
	readonly buildSimulationSnapshot: (settings: Settings, sources: SimulationSnapshotSources, interceptorTransactionStack: InterceptorTransactionStack) => SimulationSnapshot
}

const lockedNetworkReads: LockedNetworkReads = { captureNetworkState, buildSimulationSnapshot }

// Every writer of the active network or of the installed services runs inside this lock, after the effects of an earlier failed transition are completed. It is not reentrant, so the task must not start another transition or read a network snapshot through readNetworkSnapshot or readNetworkState; it reads through the builders it is given.
export async function runNetworkTransition<T>(task: (reads: LockedNetworkReads) => Promise<T>): Promise<T> {
	return await networkTransitionSemaphore.execute(async () => {
		await completeUnfinishedNetworkChangeForLockHolder()
		return await task(lockedNetworkReads)
	})
}

// The read of the active network: its settings, the stack built on them and the services installed for them, all read under the lock so they describe one network. It reads storage only, so RPC work stays outside the lock.
export async function readNetworkSnapshot(simulationServicesOwner: Pick<SimulationServicesOwner, 'getCurrent'>): Promise<NetworkSnapshot> {
	return await runNetworkTransition(async (reads) => ({ ...await reads.captureNetworkState(), services: simulationServicesOwner.getCurrent() }))
}

// readNetworkSnapshot without the services, for callers that already hold the services they simulate with, such as the shared visualisation refresh and the new-block handler, or for work that changed the stack after its snapshot was read. This read waits for a network change in progress, so the result can describe a later network than the services held; getSimulationProviderForSnapshot then refuses that pair.
export async function readNetworkState(): Promise<NetworkState> {
	return await runNetworkTransition(async (reads) => await reads.captureNetworkState())
}
