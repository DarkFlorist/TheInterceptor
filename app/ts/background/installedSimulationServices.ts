import type { SimulationServicesOwner } from '../simulation/serviceLifecycle.js'

// The background's owner of the installed simulation services, set once when the background starts. Code that must act on the client installed at this moment, never on one it captured earlier, reads it here: what the confirmation window is shown of the requested-network rule is derived with it whenever the queue is sent.
let installedSimulationServicesOwner: SimulationServicesOwner | undefined

export function setInstalledSimulationServicesOwner(simulationServicesOwner: SimulationServicesOwner) {
	installedSimulationServicesOwner = simulationServicesOwner
}

export function getInstalledSimulationServices() {
	if (installedSimulationServicesOwner === undefined) throw new Error('The simulation services are not installed yet')
	return installedSimulationServicesOwner.getCurrent()
}
