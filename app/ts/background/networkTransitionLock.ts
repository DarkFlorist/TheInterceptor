import { Semaphore } from '../utils/semaphore.js'
import { getErrorMessage } from '../utils/errors.js'
import { getActiveStackContext } from '../utils/activeStackContext.js'
import type { Settings } from '../types/interceptor-messages.js'
import type { InterceptorTransactionStack } from '../types/visualizer-types.js'
import type { SimulationServices, SimulationServicesReader } from '../simulation/serviceLifecycle.js'
import { getSettings } from './settings.js'
import { getInterceptorTransactionStack } from './storageVariables.js'
import { getCommittedNetworkChangeGeneration } from './networkChangeGeneration.js'
import { buildSimulationStateInput, readSimulationInputSources, type SimulationSnapshotSources } from './simulationInputBuilding.js'
import { getRpcNetworkChange, isSignerOnlyNetwork } from '../utils/rpcNetworkChange.js'
import type { RpcNetwork } from '../types/rpc.js'
import type { SimulationStateInput } from '../types/visualizer-types.js'

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

// The reads this module builds are defined here, and nothing here imports the modules that use them, so the dependency runs one way. Below, what every simulation read knows, also without a stack: these come from the settings and the lock, not from the stack.
export type SimulationReadIdentity = {
	readonly activeRpcNetwork: RpcNetwork
	readonly activeStackContext: ReturnType<typeof getActiveStackContext>
	// The committed network change this read was made after; a later change, even back to the same endpoint, makes it obsolete for the shared visualisation.
	readonly networkChangeGeneration: number
}

// A simulation read whose stack or input sources failed, or whose stack an unfinished network change has not cleared. Settings and services do not depend on them, so only work that uses the stack fails, with this error.
export type UnavailableSimulation = SimulationReadIdentity & {
	readonly kind: 'unavailable'
	readonly error: unknown
}

// A read for services the active network no longer uses. It has no stack, so nothing can simulate or publish for it.
type ReplacedSimulation = SimulationReadIdentity & {
	readonly kind: 'replaced'
}

export type SimulationRead = SimulationSnapshot | UnavailableSimulation | ReplacedSimulation

// One read's settings and simulation; getReadServices returns its services. Only NetworkSnapshot, which the lock module alone builds, promises that those services serve the settings; this looser type is what work on an already pending request takes, because its dialog and reply must work while a network change cannot install its services.
export type NetworkRead = {
	readonly settings: Settings
	readonly simulation: SimulationRead
}

// Only this module holds the value, so only its reads have the types below. A copy of a read can still keep the marker, which is why its services are not a field.
const readUnderNetworkLock: unique symbol = Symbol('read under the network transition lock')

// The services of each read, kept here rather than on the read: a copy of a read is another object, so it has none, and no code can give a read other services.
const servicesOfReads = new WeakMap<NetworkRead | SimulationSnapshot, SimulationServices>()

// The services a read was built with. A copied or hand-built read throws, because nothing says which network its parts describe.
export const getReadServices = (read: NetworkRead | SimulationSnapshot) => {
	const services = servicesOfReads.get(read)
	if (services === undefined) throw new Error('Only a read made under the network transition lock has services')
	return services
}

const withServices = <Read extends NetworkRead | SimulationSnapshot>(read: Read, services: SimulationServices) => {
	servicesOfReads.set(read, services)
	return read
}

// One read's stack, which simulates on the services getReadServices returns for it. Consumers take this value instead of a client next to a snapshot, so they cannot simulate a stack on another network's client. Built only here, which stamps the committed network change generation and derives simulationStateInput from interceptorTransactionStack and, like both rich-address fields, from the same settings and rich-address sources. The input is built under the lock, not where it is used: a later read outside the lock could pair this network with another network's stack, and one under the lock cannot run inside the visualisation semaphore, which a transition takes while holding the lock.
export type SimulationSnapshot = SimulationReadIdentity & {
	readonly kind: 'loaded'
	readonly simulationStateInput: SimulationStateInput
	readonly numberOfAddressesMadeRich: number
	// The active address among the rich addresses; 1.0.x simulation stack replies list its funding as a transaction.
	readonly activeAddressMadeRich: bigint | undefined
	// The stack the input was built from; Gnosis Safe signing builds its own input from the same stack.
	readonly interceptorTransactionStack: InterceptorTransactionStack
	readonly readUnderNetworkLock: typeof readUnderNetworkLock
}

// Settings, services and the simulation read with them, all describing one network. Handlers take this one value, so they cannot pair services with another read's settings.
export type NetworkSnapshot = NetworkRead & { readonly readUnderNetworkLock: typeof readUnderNetworkLock }

const buildSimulationSnapshot = (settings: Settings, sources: SimulationSnapshotSources, interceptorTransactionStack: InterceptorTransactionStack, simulationStateInput: SimulationStateInput, services: SimulationServices): SimulationSnapshot => withServices({
	...getSimulationReadIdentity(settings),
	kind: 'loaded',
	simulationStateInput,
	numberOfAddressesMadeRich: sources.richAddresses.length,
	activeAddressMadeRich: sources.activeAddressMadeRich,
	interceptorTransactionStack,
	readUnderNetworkLock,
}, services)

// Only lock holders read this, so no network change commits between reading the settings and stamping the generation.
const getSimulationReadIdentity = (settings: Settings): SimulationReadIdentity => ({
	activeRpcNetwork: settings.activeRpcNetwork,
	activeStackContext: getActiveStackContext(settings),
	networkChangeGeneration: getCommittedNetworkChangeGeneration(),
})

const createUnavailableSimulation = (settings: Settings, error: unknown): UnavailableSimulation => ({ ...getSimulationReadIdentity(settings), kind: 'unavailable', error })

// A signer-only network is never simulated, so it keeps the previous network's services and any services serve it.
const servicesServeNetwork = ({ ethereum }: SimulationServices, network: RpcNetwork) => isSignerOnlyNetwork(network) || !getRpcNetworkChange(network, ethereum.getRpcEntry()).endpointChanged

// Reads what the settings need and returns how to pair it with the services, which are read last. A stack that cannot be read becomes an explicit result rather than a failed read, so everything that needs only the settings and services carries on; the type makes each user of the stack handle it.
async function readSimulation(settings: Settings): Promise<(services: SimulationServices) => SimulationRead> {
	if (unfinishedNetworkChangeFailure !== undefined) {
		const unavailable = createUnavailableSimulation(settings, unfinishedNetworkChangeFailure)
		return () => unavailable
	}
	try {
		const sources = await readSimulationInputSources(settings)
		const interceptorTransactionStack = await getInterceptorTransactionStack()
		const simulationStateInput = buildSimulationStateInput(settings, sources, interceptorTransactionStack)
		// The one place that pairs services with a stack. Services that no longer serve the network get none: they are 'replaced', which is not the passthrough a signer-only network simulates to.
		return (services) => servicesServeNetwork(services, settings.activeRpcNetwork)
			? buildSimulationSnapshot(settings, sources, interceptorTransactionStack, simulationStateInput, services)
			: { ...getSimulationReadIdentity(settings), kind: 'replaced' }
	} catch (error: unknown) {
		const unavailable = createUnavailableSimulation(settings, error)
		return () => unavailable
	}
}

async function captureNetworkSnapshot(getServices: () => SimulationServices): Promise<NetworkSnapshot> {
	const settings = await getSettings()
	const pairSimulationWith = await readSimulation(settings)
	const services = getServices()
	return withServices({ settings, simulation: pairSimulationWith(services), readUnderNetworkLock }, services)
}

const buildNetworkSnapshot = (settings: Settings, sources: SimulationSnapshotSources, interceptorTransactionStack: InterceptorTransactionStack, services: SimulationServices): NetworkSnapshot => (
	withServices({ settings, simulation: buildSimulationSnapshot(settings, sources, interceptorTransactionStack, buildSimulationStateInput(settings, sources, interceptorTransactionStack), services), readUnderNetworkLock }, services)
)

// The snapshot builders, handed only to tasks that hold the lock: they read storage without taking it, so outside the lock they could pair one network's settings or stack with a later network's generation.
export type LockedNetworkReads = {
	readonly captureNetworkSnapshot: typeof captureNetworkSnapshot
	readonly buildNetworkSnapshot: typeof buildNetworkSnapshot
}

const lockedNetworkReads: LockedNetworkReads = { captureNetworkSnapshot, buildNetworkSnapshot }

// Everything that writes the active network, the installed services or the stack runs inside this lock, and work that changes the stack runs only after an earlier failed transition is completed. The lock is not reentrant, so the task must not start another transition or read a network snapshot through readNetworkSnapshot or readNetworkSnapshotForServices; it reads through the reads it is given.
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
export async function readNetworkSnapshot(simulationServicesOwner: SimulationServicesReader): Promise<NetworkSnapshot> {
	return await runStackIndependentNetworkTask(async (reads) => await reads.captureNetworkSnapshot(simulationServicesOwner.getCurrent))
}

// For a request that is already pending, whose dialog and known outcome must keep working even while the committed network's services cannot be installed. In that state these services still serve the previous network, so the simulation is unavailable and nothing simulates; they serve only the reply and the dialog. The result is therefore a NetworkRead, which cannot be passed as a NetworkSnapshot.
export async function readNetworkSnapshotForPendingRequest(simulationServicesOwner: SimulationServicesReader): Promise<NetworkRead> {
	return await networkTransitionSemaphore.execute(async () => {
		await retryUnfinishedNetworkChange()
		return await captureNetworkSnapshot(simulationServicesOwner.getCurrent)
	})
}

// For callers that already hold the services they work with, such as the shared visualisation refresh and the new-block handler, or that changed the stack after their snapshot was read. This read waits for a network change in progress, so the held services may have been replaced by the time it returns: its simulation then says so, because this race is expected on any network switch and that change refreshes its own network.
export async function readNetworkSnapshotForServices(services: SimulationServices): Promise<NetworkSnapshot> {
	return await runStackIndependentNetworkTask(async (reads) => await reads.captureNetworkSnapshot(() => services))
}
