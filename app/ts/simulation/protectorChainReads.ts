import { type SimulationState, toResolvedSimulationState } from '../types/visualizer-types.js'
import type { EthereumClientService } from './services/EthereumClientService.js'
import { getSimulatedCode } from './services/SimulationModeEthereumClientService.js'
import type { ProtectorChainReads } from './protectorTypes.js'

export const createLiveProtectorChainReads = (ethereum: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: SimulationState): ProtectorChainReads => ({
	readCode: async (address) => {
		const code = await getSimulatedCode(ethereum, requestAbortController, toResolvedSimulationState(simulationState), address)
		return code.statusCode === 'failure' ? 'unverified' : code.getCodeReturn.length > 0 ? 'present' : 'absent'
	},
	readGasPrice: async () => await ethereum.getGasPrice(requestAbortController),
})
