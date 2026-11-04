import { Semaphore } from '../utils/semaphore.js'
import { getSettings } from './settings.js'
import { captureSimulationSnapshot, type NetworkState } from './simulationUpdating.js'

// The lock that every writer of the active network or of the installed services runs in, and the network state read under it. networkTransition.ts runs network changes in this lock and leaves here the repair of a change that failed part-way, as a callback, so this module imports neither the transition module nor the popup visualisation layer. The visualisation layer reads network state through this module: networkTransition.ts publishes to that layer, so importing it there would make the modules import each other.

const networkTransitionSemaphore = new Semaphore(1)

// Completes the effects that a failed transition could not complete. They belong to the lock rather than to a call chain: the failed transition has already thrown to its caller, so the next lock holder, a read included, completes them before it acts on the committed network. They live in memory only, so after a background restart services are rebuilt from the settings and websites receive the chain when they reconnect, but a stack left from the previous chain is not cleared.
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

// Every writer of the active network or of the installed services runs inside this lock, after the effects of an earlier failed transition are completed. It is not reentrant, so the task must not start another transition or read a network snapshot.
export async function runNetworkTransition<T>(task: () => Promise<T>): Promise<T> {
	return await networkTransitionSemaphore.execute(async () => {
		await completeUnfinishedNetworkChange()
		return await task()
	})
}

// Reads the settings and the stack built on them. Callers hold the network transition lock, so both describe one network.
export async function captureNetworkState(): Promise<NetworkState> {
	const settings = await getSettings()
	return { settings, simulation: await captureSimulationSnapshot(settings) }
}

// The settings and stack as they are now, for work that changed the stack after its snapshot was read.
export async function readNetworkState() {
	return await runNetworkTransition(captureNetworkState)
}
