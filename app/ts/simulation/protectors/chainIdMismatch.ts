import type { SimulationState, WebsiteCreatedEthereumTransaction } from '../../types/visualizer-types.js'
import type { EthereumClientService } from '../services/EthereumClientService.js'
import { getChainName } from '../../utils/constants.js'

export async function chainIdMismatch({ transaction }: WebsiteCreatedEthereumTransaction, ethereum: EthereumClientService, _requestAbortController: AbortController | undefined, _simulationState: SimulationState) {
	if (transaction.chainId === undefined) return
	const connectedChainId = ethereum.getChainId()
	if (transaction.chainId !== connectedChainId) return `This transaction is for a different chain (${ getChainName(transaction.chainId) }) than what you are currently connected to (${ getChainName(connectedChainId) }).`
	return
}
