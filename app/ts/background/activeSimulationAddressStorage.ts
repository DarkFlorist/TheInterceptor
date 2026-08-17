import type { EthereumAddress } from '../types/wire-types.js'

export function createIndependentActiveSimulationAddressStorageUpdate(activeSimulationAddress: EthereumAddress | undefined) {
	return { activeSimulationAddress, hasIndependentActiveSimulationAddress: true } as const
}
