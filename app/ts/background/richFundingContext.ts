import type { Settings } from '../types/interceptor-messages.js'
import type { IEthereumClientService } from '../simulation/services/EthereumClientService.js'
import { richFundingRejected } from '../types/richMode.js'

// The funding key travels from the owner's home snapshot through the edit request. Under settings-command admission, reject stale popup edits and a client that has not installed the selected network before any probe or write.
export function validateRichFundingChain(settings: Pick<Settings, 'activeRpcNetwork'>, ethereum: Pick<IEthereumClientService, 'getChainId'>, requestedChainId: bigint | undefined) {
	const chainId = settings.activeRpcNetwork.chainId
	if (ethereum.getChainId() !== chainId || (requestedChainId !== undefined && requestedChainId !== chainId)) return richFundingRejected('The funding network changed. Reload the balance editor before trying again.')
	return undefined
}
