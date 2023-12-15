import { EthereumUnsignedTransaction } from '../../types/wire-types.js'
import { parseTransaction } from '../../utils/calldata.js'
import { SimulationState } from '../../types/visualizer-types.js'
import { EthereumClientService } from '../services/EthereumClientService.js'
import { getCodeOrError } from './commonTokenOops.js'
import { identifyAddress } from '../../background/metadataUtils.js'

export async function tokenToContract(transaction: EthereumUnsignedTransaction, ethereum: EthereumClientService, simulationState: SimulationState) {
	const transferInfo = parseTransaction(transaction)
	if (transferInfo === undefined) return
	if (transferInfo.name !== 'transfer' && transferInfo.name !== 'transferFrom') return
	const code = await getCodeOrError(ethereum, simulationState, transferInfo.arguments.to)
	if (code.statusCode === 'failure') return code.message
	if (code.getCodeReturn.length === 0) return
	if (transaction.to === null) return
	const to = await identifyAddress(ethereum, transferInfo.arguments.to)
	return `Attempt to send tokens directly to a contract (${ to.name })`
}
