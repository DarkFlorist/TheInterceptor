import type { SimulationServicesOwner, SimulationServicesUpdate } from '../simulation/serviceLifecycle.js'
import { Semaphore } from '../utils/semaphore.js'

const settingsTransitions = new Semaphore(1)

// Active selection and RPC-list edits share stored authority. Serialize their writes, installation and notifications here, while lifecycle refresh observers run after releasing this application lock.
export async function runSimulationSettingsTransition<Result>(owner: SimulationServicesOwner, apply: (update: SimulationServicesUpdate) => Promise<Result>): Promise<Result> {
	return await owner.update(async (update) => await settingsTransitions.execute(async () => await apply(update)))
}
