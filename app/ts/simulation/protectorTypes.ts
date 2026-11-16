import type { OriginalSendRequestParameters } from '../types/JsonRpc-types.js'
import type { EthereumUnsignedTransaction } from '../types/wire-types.js'
import type { EthereumClientService } from './services/EthereumClientService.js'
import type { SimulationState } from '../types/visualizer-types.js'
import type { EnrichedEthereumEvents } from '../types/EnrichedEthereumData.js'

export type ProtectorRequestContext = {
	readonly transaction: EthereumUnsignedTransaction
	readonly originalRequestParameters: OriginalSendRequestParameters
}

// Every configured protector receives the same request context and shared simulation inputs.
export type Protector = (
	request: ProtectorRequestContext,
	ethereum: EthereumClientService,
	requestAbortController: AbortController | undefined,
	simulationState: SimulationState,
	eventsPromise: Promise<EnrichedEthereumEvents>,
) => Promise<string | undefined>
