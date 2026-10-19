import type { EthereumUnsignedTransaction } from '../../types/wire-types.js'
import { parseTransaction } from '../../utils/calldata.js'
import type { ProtectorChainReads } from '../protectorChainReads.js'
import type { IdentifyAddress } from '../../background/metadataUtils.js'

export async function selfTokenOops(transaction: EthereumUnsignedTransaction, _connectedChainId: bigint, _identify: IdentifyAddress, _chainReads: ProtectorChainReads) {
	const transferInfo = parseTransaction(transaction)
	if (transferInfo === undefined) return
	if (transferInfo.name !== 'transfer' && transferInfo.name !== 'transferFrom') return
	if (transaction.to !== transferInfo.arguments.to) return
	return 'Attempt to send token to itself.'
}
