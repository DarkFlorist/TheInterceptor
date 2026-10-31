import type { EthereumUnsignedTransaction } from '../../types/wire-types.js'
import { getChainName } from '../../utils/constants.js'

export async function chainIdMismatch(transaction: EthereumUnsignedTransaction, connectedChainId: bigint) {
	if (transaction.chainId === undefined) return
	if (transaction.chainId !== connectedChainId) return `This transaction is for a different chain (${ getChainName(transaction.chainId) }) than what you are currently connected to (${ getChainName(connectedChainId) }).`
	return
}
