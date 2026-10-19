import type { EthereumUnsignedTransaction } from '../../types/wire-types.js'
import type { ProtectorChainReads } from '../protectorChainReads.js'
import type { IdentifyAddress } from '../../types/metadataLookups.js'
import { getCodeOrError } from './commonTokenOops.js'

export async function eoaCalldata(transaction: EthereumUnsignedTransaction, _connectedChainId: bigint, chainReads: ProtectorChainReads, identify: IdentifyAddress) {
	if (transaction.to === null) return
	if (transaction.input.length === 0) return
	const code = await getCodeOrError(chainReads, identify, transaction.to)
	if (code.statusCode === 'failure') return code.message
	if (code.hasCode) return
	return 'Transaction to an Externally Owned Account contains calldata.'
}

