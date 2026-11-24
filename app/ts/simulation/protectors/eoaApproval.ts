import type { ProtectorContext } from '../protectorTypes.js'
import type { EthereumUnsignedTransaction } from '../../types/wire-types.js'
import { parseTransaction } from '../../utils/calldata.js'
import { getCodeOrError } from './codeVerification.js'

export async function eoaApproval(transaction: EthereumUnsignedTransaction, { chainReads, identify }: Pick<ProtectorContext, 'chainReads' | 'identify'>) {
	const approvalInfo = parseTransaction(transaction)
	if (approvalInfo === undefined) return
	if (approvalInfo.name === 'approve') {
		if (approvalInfo.arguments.value === 0n) return // approving 0 is allowed
		const code = await getCodeOrError(chainReads, identify, approvalInfo.arguments.spender)
		if (code.statusCode === 'failure') return code.message
		if (code.hasCode) return
		return 'This transaction attemps to approve Externally Owned Account.'
	}
	if (approvalInfo.name === 'setApprovalForAll') {
		if (approvalInfo.arguments.approved === false) return // setting approval off is allowed
		const code = await getCodeOrError(chainReads, identify, approvalInfo.arguments.operator)
		if (code.statusCode === 'failure') return code.message
		if (code.hasCode) return
		return 'This transaction attempts to approve an Externally Owned Account.'
	}
	return
}
