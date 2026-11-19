import type { SimulationServicesOwner, SimulationServicesUpdate } from '../simulation/serviceLifecycle.js'
import { Semaphore } from '../utils/semaphore.js'

// The only lock for active-selection and RPC-list transitions: their settings writes, service installation, popup and website messaging, access reconciliation and selection refresh requests run under it one at a time.
const simulationSettingsTransitionLock = new Semaphore(1)

// The owner's update takes no lock; it only scopes the replacement's refresh intent, so it wraps this lock to run the refresh observer after the lock is released. A transition must not start another transition, or it waits on itself.
export async function runSimulationSettingsTransition<Result>(owner: SimulationServicesOwner, apply: (update: SimulationServicesUpdate) => Promise<Result>): Promise<Result> {
	return await owner.update(async (update) => await simulationSettingsTransitionLock.execute(async () => await apply(update)))
}
