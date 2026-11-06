// The simulation input of the active network, read like production code reads it: under the network transition lock. The modules load here because each test installs its browser mock first.
export async function readActiveSimulationInput() {
	const { readNetworkState } = await import('../../app/ts/background/networkTransitionLock.js')
	const { requireSimulationSnapshot } = await import('../../app/ts/background/simulationUpdating.js')
	return requireSimulationSnapshot((await readNetworkState()).simulation).simulationStateInput
}
