import { UNISWAP_V2_ROUTER_ADDRESS, SUSHISWAP_V2_ROUTER_ADDRESS, UNISWAP_V3_ROUTER } from '../../utils/constants.js'
import { Simulator } from '../simulator.js'
import { EthereumUnsignedTransaction } from '../../utils/wire-types.js'
import { getTransferInfoFromTx } from '../../utils/calldata.js'
import { nftMetadata, tokenMetadata } from '@darkflorist/address-metadata'
import { addressString } from '../../utils/bigint.js'

export const ADDITIONAL_BAD_TRANSFER_TARGETS = new Set<bigint>([
	UNISWAP_V2_ROUTER_ADDRESS,
	SUSHISWAP_V2_ROUTER_ADDRESS,
	UNISWAP_V3_ROUTER
])

export async function commonTokenOops(transaction: EthereumUnsignedTransaction, _simulator: Simulator) {
	const transferInfo = getTransferInfoFromTx(transaction)
	if (transferInfo === undefined) return
	if (transaction.to === null) return
	if (!ADDITIONAL_BAD_TRANSFER_TARGETS.has(transferInfo.to)) return
	if (tokenMetadata.get(addressString(transferInfo.to)) === undefined) return
	if (nftMetadata.get(addressString(transferInfo.to)) === undefined) return
	return 'ERC20_UNINTENDED_CONTRACT'
}
