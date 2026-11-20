import type { ProtectorContext } from '../protectorTypes.js'
import { UNISWAP_V2_ROUTER_ADDRESS, SUSHISWAP_V2_ROUTER_ADDRESS, UNISWAP_V3_ROUTER } from '../../utils/constants.js'
import type { EthereumAddress, EthereumUnsignedTransaction } from '../../types/wire-types.js'
import { erc1155Metadata, erc721Metadata, tokenMetadata } from '@darkflorist/address-metadata'
import { addressString } from '../../utils/bigint.js'
import { parseTransaction } from '../../utils/calldata.js'

const ADDITIONAL_BAD_TRANSFER_TARGETS = new Set<bigint>([
	UNISWAP_V2_ROUTER_ADDRESS,
	SUSHISWAP_V2_ROUTER_ADDRESS,
	UNISWAP_V3_ROUTER
])

const hasKnownCommonTokenMetadata = (address: EthereumAddress) => {
	const normalizedAddress = addressString(address)
	return tokenMetadata.has(normalizedAddress) || erc721Metadata.has(normalizedAddress) || erc1155Metadata.has(normalizedAddress)
}

export async function commonTokenOops(transaction: EthereumUnsignedTransaction, { identify }: Pick<ProtectorContext, 'identify'>) {
	const transferInfo = parseTransaction(transaction)
	if (transferInfo === undefined) return
	if (transaction.to === null) return
	if (transferInfo.name !== 'transfer' && transferInfo.name !== 'transferFrom') return
	if (!ADDITIONAL_BAD_TRANSFER_TARGETS.has(transferInfo.arguments.to)) return
	if (!hasKnownCommonTokenMetadata(transaction.to)) return
	const to = await identify(transferInfo.arguments.to)
	return `Attempt to send tokens to a contract (${ to.name }) that cannot receive such tokens`
}
