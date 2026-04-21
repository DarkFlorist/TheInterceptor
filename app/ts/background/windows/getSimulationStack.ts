import { getSimulatedStackV1, getSimulatedStackV2 } from '../../simulation/SimulationStackExtraction.js'
import { getAddressToMakeRich } from '../../simulation/services/SimulationModeEthereumClientService.js'
import { SimulationState } from '../../types/visualizer-types.js'
import { SimulationStackVersion } from '../../types/JsonRpc-types.js'
import { assertNever } from '../../utils/typescript.js'

export async function getSimulationStack(simulationState: SimulationState | undefined, version: SimulationStackVersion) {
	switch (version) {
		case '2.0.0': return { version, payload: getSimulatedStackV2(simulationState) } as const
		case '1.0.0':
		case '1.0.1': {
			const addressToMakeRich = await getAddressToMakeRich()
			return { version, payload: getSimulatedStackV1(simulationState, addressToMakeRich, version) } as const
		}
		default: assertNever(version)
	}
}
