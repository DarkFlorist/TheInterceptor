import type { EthereumUnsignedTransaction } from '../../types/wire-types.js'
import { parseTransaction } from '../../utils/calldata.js'
import type { ProtectorChainReads } from '../protectorChainReads.js'
import type { EthereumClientService } from '../services/EthereumClientService.js'
import { getCodeOrError } from './commonTokenOops.js'
import type { IdentifyAddress } from '../../background/metadataUtils.js'

export async function tokenToContract(transaction: EthereumUnsignedTransaction, _ethereum: EthereumClientService, identify: IdentifyAddress, chainReads: ProtectorChainReads) {
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
