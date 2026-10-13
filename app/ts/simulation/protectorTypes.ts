import type { EthereumUnsignedTransaction } from '../types/wire-types.js'
import type { EthereumClientService } from './services/EthereumClientService.js'
import type { SimulationState } from '../types/visualizer-types.js'
import type { EnrichedEthereumEvents } from '../types/EnrichedEthereumData.js'

// Every configured protector checks the resolved transaction through the same interface.
export type Protector = (
	transaction: EthereumUnsignedTransaction,
	ethereum: EthereumClientService,
	requestAbortController: AbortController | undefined,
	simulationState: SimulationState,
	eventsPromise: Promise<EnrichedEthereumEvents>,
) => Promise<string | undefined>
