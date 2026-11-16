// The simulation input of the active network, read like production code reads it: under the network transition lock. The input does not depend on the client, so a stand-in for one serves the tests that have none. The modules load here because each test installs its browser mock first.
export async function readActiveSimulationInput() {
	const { readNetworkSnapshot } = await import('../../app/ts/background/networkTransitionLock.js')
	const { getSettings } = await import('../../app/ts/background/settings.js')
	const { requireSimulationSnapshot } = await import('../../app/ts/background/simulationUpdating.js')
	const { activeRpcNetwork } = await getSettings()
	return requireSimulationSnapshot((await readNetworkSnapshot({ getCurrent: () => ({ ethereum: { isRetired: () => false, getRpcEntry: () => activeRpcNetwork }, tokenPriceService: {} }) })).simulation).simulationStateInput
}

// Fixtures that keep their selected network require a coherent snapshot; a replaced client is a setup failure rather than a usable snapshot.
export async function readTestNetworkSnapshot(services: Parameters<typeof import('../../app/ts/background/networkTransitionLock.js').readNetworkSnapshotForServices>[0]) {
	const { readNetworkSnapshotForServices } = await import('../../app/ts/background/networkTransitionLock.js')
	const network = await readNetworkSnapshotForServices(services)
	if (network === undefined) throw new Error('The test services no longer serve the selected network')
	return network
}
