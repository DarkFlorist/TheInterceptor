import { UNISWAP_V2_ROUTER_ADDRESS, SUSHISWAP_V2_ROUTER_ADDRESS, UNISWAP_V3_ROUTER } from '../../utils/constants.js'
import { EthereumUnsignedTransaction } from '../../types/wire-types.js'
import { erc1155Metadata, erc721Metadata, tokenMetadata } from '@darkflorist/address-metadata'
import { addressString } from '../../utils/bigint.js'
import { parseTransaction } from '../../utils/calldata.js'
import { SimulationState } from '../../types/visualizer-types.js'
import { EthereumClientService } from '../services/EthereumClientService.js'

export const ADDITIONAL_BAD_TRANSFER_TARGETS = new Set<bigint>([
	UNISWAP_V2_ROUTER_ADDRESS,
	SUSHISWAP_V2_ROUTER_ADDRESS,
	UNISWAP_V3_ROUTER
])

export async function commonTokenOops(transaction: EthereumUnsignedTransaction, _ethereum: EthereumClientService, _simulationState: SimulationState) {
	const transferInfo = parseTransaction(transaction)
	if (transferInfo === undefined) return
	if (transaction.to === null) return
	if (transferInfo.name !== 'transfer' && transferInfo.name !== 'transferFrom') return
	if (!ADDITIONAL_BAD_TRANSFER_TARGETS.has(transferInfo.arguments.to)) return
	if (tokenMetadata.get(addressString(transferInfo.arguments.to)) === undefined) return
	if (erc721Metadata.get(addressString(transferInfo.arguments.to)) === undefined) return
	if (erc1155Metadata.get(addressString(transferInfo.arguments.to)) === undefined) return
	return 'ERC20_UNINTENDED_CONTRACT'
}
