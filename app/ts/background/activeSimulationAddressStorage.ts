import type { EthereumAddress } from '../types/wire-types.js'

export function createIndependentActiveSimulationAddressStorageUpdate(activeSimulationAddress: EthereumAddress | undefined) {
	return { independentActiveSimulationAddress: activeSimulationAddress } as const
}
