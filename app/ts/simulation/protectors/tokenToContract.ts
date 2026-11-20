import type { ProtectorContext } from '../protectorTypes.js'
import type { EthereumUnsignedTransaction } from '../../types/wire-types.js'
import { parseTransaction } from '../../utils/calldata.js'
import { getCodeOrError } from './codeVerification.js'

export async function tokenToContract(transaction: EthereumUnsignedTransaction, { chainReads, identify }: Pick<ProtectorContext, 'chainReads' | 'identify'>) {
	const transferInfo = parseTransaction(transaction)
	if (transferInfo === undefined) return
	if (transferInfo.name !== 'transfer' && transferInfo.name !== 'transferFrom') return
	const code = await getCodeOrError(chainReads, identify, transferInfo.arguments.to)
	if (code.statusCode === 'failure') return code.message
	if (!code.hasCode) return
	if (transaction.to === null) return
	const to = await identify(transferInfo.arguments.to)
	return `Attempt to send tokens directly to a contract (${ to.name })`
}
