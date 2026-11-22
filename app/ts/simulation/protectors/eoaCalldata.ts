import type { ProtectorContext } from '../protectorTypes.js'
import type { EthereumUnsignedTransaction } from '../../types/wire-types.js'
import { getCodeOrError } from './codeVerification.js'

export async function eoaCalldata(transaction: EthereumUnsignedTransaction, { chainReads, identify }: Pick<ProtectorContext, 'chainReads' | 'identify'>) {
	if (transaction.to === null) return
	if (transaction.input.length === 0) return
	const code = await getCodeOrError(chainReads, identify, transaction.to)
	if (code.statusCode === 'failure') return code.message
	if (code.hasCode) return
	return 'Transaction to an Externally Owned Account contains calldata.'
}

