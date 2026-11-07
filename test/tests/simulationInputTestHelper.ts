// The simulation input of the active network, read like production code reads it: under the network transition lock. The input does not depend on the client, so a stand-in for one serves the tests that have none. The modules load here because each test installs its browser mock first.
export async function readActiveSimulationInput() {
	const { readNetworkSnapshot } = await import('../../app/ts/background/networkTransitionLock.js')
	const { getSettings } = await import('../../app/ts/background/settings.js')
	const { requireSimulationSnapshot } = await import('../../app/ts/background/simulationUpdating.js')
	const { activeRpcNetwork } = await getSettings()
	return requireSimulationSnapshot((await readNetworkSnapshot({ getCurrent: () => ({ ethereum: { getRpcEntry: () => activeRpcNetwork }, tokenPriceService: {} }) })).simulation).simulationStateInput
}
