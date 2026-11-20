import { selfTokenOops } from './protectors/selfTokenOops.js'
import { feeOops } from './protectors/feeOops.js'
import { commonTokenOops } from './protectors/commonTokenOops.js'
import { eoaApproval } from './protectors/eoaApproval.js'
import { eoaCalldata } from './protectors/eoaCalldata.js'
import { tokenToContract } from './protectors/tokenToContract.js'
import type { EthereumUnsignedTransaction } from '../types/wire-types.js'
import { sendToNonContact } from './protectors/sendToNonContactAddress.js'
import { chainIdMismatch } from './protectors/chainIdMismatch.js'
import { promiseAllMapAbortSafe } from '../utils/requests.js'
import type { Protector, ProtectorContext } from './protectorTypes.js'

const PROTECTORS: readonly Protector[] = [
	selfTokenOops,
	commonTokenOops,
	feeOops,
	eoaApproval,
	eoaCalldata,
	tokenToContract,
	sendToNonContact,
	chainIdMismatch,
]

export const runProtectorsForTransaction = async (transaction: EthereumUnsignedTransaction, context: ProtectorContext) => {
	const reasons = await promiseAllMapAbortSafe(PROTECTORS, async (protectorMethod) => await protectorMethod(transaction, context))
	const filteredReasons = reasons.filter((reason): reason is string => reason !== undefined)
	return {
		quarantine: filteredReasons.length > 0,
		quarantineReasons: Array.from(new Set<string>(filteredReasons)),
	}
}
