import { Semaphore } from '../utils/semaphore.js'
import { getErrorMessage } from '../utils/errors.js'
import { getActiveStackContext } from '../utils/activeStackContext.js'
import type { Settings } from '../types/interceptor-messages.js'
import type { InterceptorTransactionStack } from '../types/visualizer-types.js'
import type { SimulationServicesOwner } from '../simulation/serviceLifecycle.js'
import { getSettings } from './settings.js'
import { getInterceptorTransactionStack } from './storageVariables.js'
import { getCommittedNetworkChangeGeneration } from './networkChangeGeneration.js'
import { buildSimulationStateInput, readSimulationInputSources, type NetworkSnapshot, type NetworkState, type SimulationRead, type SimulationSnapshot, type SimulationSnapshotSources, type UnavailableSimulation } from './simulationUpdating.js'

// The lock that every writer of the active network or of the installed services runs in, and the only place network snapshots are built. networkTransition.ts runs network changes in this lock and leaves here the repair of a change that failed part-way, as a callback, so this module imports neither the transition module nor the popup visualisation layer. The visualisation layer reads network state through this module: networkTransition.ts publishes to that layer, so importing it there would make the modules import each other.

const networkTransitionSemaphore = new Semaphore(1)

// The effects that a failed transition could not complete. They belong to the lock rather than to a call chain: the failed transition has already thrown to its caller, so the next lock holder, a read included, retries them. Reads retry too because the settings of the new network are already committed: there is no pre-transition state left to return. They live in memory only, so after a background restart services are rebuilt from the settings and websites receive the chain when they reconnect, but a stack left from the previous chain is not cleared.
export type UnfinishedNetworkChange = {
	// Safe to retry: it stays recorded until it succeeds.
	readonly complete: () => Promise<void>
	// Until the committed network's services are installed, its settings and the installed services describe two networks. After that only the stack and notifications are owed, which stop simulation but not work that needs no stack.
	readonly servicesInstalled: () => boolean
}

let unfinishedNetworkChange: UnfinishedNetworkChange | undefined
// Why the last attempt failed. While it is set the stored stack may be the previous chain's, so no simulation read returns it.
let unfinishedNetworkChangeFailure: Error | undefined

// Called under the lock by a transition that committed a network change and then failed. An earlier change that is still unfinished stays owed, before this one.
export function recordUnfinishedNetworkChange(change: UnfinishedNetworkChange) {
	const earlierChange = unfinishedNetworkChange
	unfinishedNetworkChange = earlierChange === undefined ? change : {
		complete: async () => {
			await earlierChange.complete()
			await change.complete()
		},
		servicesInstalled: () => earlierChange.servicesInstalled() && change.servicesInstalled(),
	}
}

// Runs under the lock. While the change stays unfinished this throws its failure.
export async function completeUnfinishedNetworkChange() {
	if (unfinishedNetworkChange === undefined) return
	await unfinishedNetworkChange.complete()
	unfinishedNetworkChange = undefined
	unfinishedNetworkChangeFailure = undefined
}

// Every lock holder retries the unfinished change first. The failure names the change, rather than the bare failure of a write the holder did not make.
async function retryUnfinishedNetworkChange() {
	try {
		await completeUnfinishedNetworkChange()
	} catch (error: unknown) {
		unfinishedNetworkChangeFailure = new Error(`An earlier network change committed its settings but could not finish applying them: ${ getErrorMessage(error) ?? 'unknown error' }`)
	}
	return unfinishedNetworkChangeFailure
}

// Stamps the committed network change generation onto the settings, sources and stack it is given. Only lock holders build snapshots, so no network change commits between reading those and stamping the generation.
function buildSimulationSnapshot(settings: Settings, sources: SimulationSnapshotSources, interceptorTransactionStack: InterceptorTransactionStack): SimulationSnapshot {
	return {
		kind: 'loaded',
		activeRpcNetwork: settings.activeRpcNetwork,
		activeStackContext: getActiveStackContext(settings),
		simulationStateInput: buildSimulationStateInput(settings, sources, interceptorTransactionStack),
		numberOfAddressesMadeRich: sources.richAddresses.length,
		activeAddressMadeRich: sources.activeAddressMadeRich,
		interceptorTransactionStack,
		networkChangeGeneration: getCommittedNetworkChangeGeneration(),
	}
}

// A stack that cannot be read becomes an explicit result rather than a failed read, so everything that needs only the settings and services carries on; the type makes each user of the stack handle it.
async function readSimulation(settings: Settings): Promise<SimulationRead> {
	try {
		const sources = await readSimulationInputSources(settings)
		return buildSimulationSnapshot(settings, sources, await getInterceptorTransactionStack())
	} catch (error: unknown) {
		return createUnavailableSimulation(settings, error)
	}
}

const createUnavailableSimulation = (settings: Settings, error: unknown): UnavailableSimulation => (
	{ kind: 'unavailable', error, activeRpcNetwork: settings.activeRpcNetwork, activeStackContext: getActiveStackContext(settings), networkChangeGeneration: getCommittedNetworkChangeGeneration() }
)

async function captureNetworkState(): Promise<NetworkState> {
	const settings = await getSettings()
	return { settings, simulation: unfinishedNetworkChangeFailure === undefined ? await readSimulation(settings) : createUnavailableSimulation(settings, unfinishedNetworkChangeFailure) }
}

// The snapshot builders, handed only to tasks that hold the lock: they read storage without taking it, so outside the lock they could pair one network's settings or stack with a later network's generation.
export type LockedNetworkReads = {
	readonly captureNetworkState: () => Promise<NetworkState>
	readonly buildSimulationSnapshot: (settings: Settings, sources: SimulationSnapshotSources, interceptorTransactionStack: InterceptorTransactionStack) => SimulationSnapshot
}

const lockedNetworkReads: LockedNetworkReads = { captureNetworkState, buildSimulationSnapshot }

// Everything that writes the active network, the installed services or the stack runs inside this lock, and work that changes the stack runs only after an earlier failed transition is completed. The lock is not reentrant, so the task must not start another transition or read a network snapshot through readNetworkSnapshot or readNetworkState; it reads through the reads it is given.
export async function runNetworkTransition<T>(task: (reads: LockedNetworkReads) => Promise<T>): Promise<T> {
	return await networkTransitionSemaphore.execute(async () => {
		const failure = await retryUnfinishedNetworkChange()
		if (failure !== undefined) throw failure
		return await task(lockedNetworkReads)
	})
}

// For work that needs coherent settings and services but no stack: it proceeds while only the stack or notifications are owed, and any simulation it reads is unavailable.
export async function runStackIndependentNetworkTask<T>(task: (reads: LockedNetworkReads) => Promise<T>): Promise<T> {
	return await networkTransitionSemaphore.execute(async () => {
		const failure = await retryUnfinishedNetworkChange()
		if (failure !== undefined && unfinishedNetworkChange?.servicesInstalled() === false) throw failure
		return await task(lockedNetworkReads)
	})
}

// The read of the active network: its settings, the stack built on them and the services installed for them, all read under the lock so they describe one network. It reads storage only, so RPC work stays outside the lock. Settings and services always come back together; a stack that cannot be read, or that a network change could not clear, comes back as an unavailable simulation.
export async function readNetworkSnapshot(simulationServicesOwner: Pick<SimulationServicesOwner, 'getCurrent'>): Promise<NetworkSnapshot> {
	return await runStackIndependentNetworkTask(async (reads) => ({ ...await reads.captureNetworkState(), services: simulationServicesOwner.getCurrent() }))
}

// For a request that is already pending, whose dialog and known outcome must keep working even while the committed network's services cannot be installed. In that state these services still serve the previous network, so the simulation is unavailable and nothing simulates; they serve only the reply and the dialog.
export async function readNetworkSnapshotForPendingRequest(simulationServicesOwner: Pick<SimulationServicesOwner, 'getCurrent'>): Promise<NetworkSnapshot> {
	return await networkTransitionSemaphore.execute(async () => {
		await retryUnfinishedNetworkChange()
		return { ...await captureNetworkState(), services: simulationServicesOwner.getCurrent() }
	})
}

// readNetworkSnapshot without the services, for callers that already hold the services they simulate with, such as the shared visualisation refresh and the new-block handler, or for work that changed the stack after its snapshot was read. This read waits for a network change in progress, so the result can describe a later network than the services held; getSimulationProviderForSnapshot then refuses that pair.
export async function readNetworkState(): Promise<NetworkState> {
	return await runStackIndependentNetworkTask(async (reads) => await reads.captureNetworkState())
}
