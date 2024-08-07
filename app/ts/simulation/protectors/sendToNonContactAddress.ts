import { EthereumAddress, EthereumUnsignedTransaction } from '../../types/wire-types.js'
import { parseTransaction } from '../../utils/calldata.js'
import { SimulationState } from '../../types/visualizer-types.js'
import { EthereumClientService } from '../services/EthereumClientService.js'
import { identifyAddress } from '../../background/metadataUtils.js'

export async function sendToNonContact(transaction: EthereumUnsignedTransaction, ethereum: EthereumClientService, requestAbortController: AbortController | undefined, _simulationState: SimulationState) {
	async function checkSendToAddress(to: EthereumAddress) {
		const sendingTo = await identifyAddress(ethereum, requestAbortController, to)
		if (sendingTo.entrySource !== 'OnChain') return
		return `This transaction sends funds to "${ sendingTo.name }", which is not in the addressbook. Please add the address to addressbook to dismiss this error in the future.`
	}

	const transferInfo = parseTransaction(transaction)
	if (transferInfo === undefined) {
		if (transaction.input.length === 0 && transaction.value > 0 && transaction.to !== null) return await checkSendToAddress(transaction.to)
		return 
	}
	if (transferInfo.name !== 'transfer' && transferInfo.name !== 'transferFrom') return
	return await checkSendToAddress(transferInfo.arguments.to)
}
