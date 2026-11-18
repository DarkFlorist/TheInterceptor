import { readNetworkSnapshotForServices, type NetworkRead, type NetworkSnapshot } from '../../../app/ts/background/networkTransitionLock.js'
import type { SimulationServices } from '../../../app/ts/simulation/serviceLifecycle.js'

declare const consumeSnapshot: (network: NetworkSnapshot) => void

export async function verifySnapshotAdmission(services: SimulationServices, pendingRead: NetworkRead) {
	const network = await readNetworkSnapshotForServices(services)
	consumeSnapshot(network) // expect-type-error
	if (network !== undefined) consumeSnapshot(network)
	consumeSnapshot(pendingRead) // expect-type-error
	const replaced: NetworkSnapshot['simulation']['kind'] = 'replaced' // expect-type-error
	return replaced
}
