import { EthereumAddress, EthereumUnsignedTransaction } from '../../types/wire-types.js'
import { parseTransaction } from '../../utils/calldata.js'
import { SimulationState } from '../../types/visualizer-types.js'
import { EthereumClientService } from '../services/EthereumClientService.js'
import { identifyAddress } from '../../background/metadataUtils.js'
import { getSettings } from '../../background/settings.js'
import { checksummedAddress } from '../../utils/bigint.js'

export async function sendToNonContact(transaction: EthereumUnsignedTransaction, ethereum: EthereumClientService, _simulationState: SimulationState) {
	async function checkSendToAddress(to: EthereumAddress) {
		const userAddressBook = (await getSettings()).userAddressBook
		const sendingTo = await identifyAddress(ethereum, userAddressBook, to)
		if (!(sendingTo.entrySource === 'OnChain' || sendingTo.entrySource === 'FilledIn')) return
		return `You are about to send funds to ${ checksummedAddress(to) }, which is not in your addressbook. Please add the address to addressbook to dismiss this error for the future.`
	}

	const transferInfo = parseTransaction(transaction)
	if (transferInfo === undefined) {
		if (transaction.input.length === 0 && transaction.value > 0 && transaction.to !== null) return await checkSendToAddress(transaction.to)
		return 
	}
	if (transferInfo.name !== 'transfer' && transferInfo.name !== 'transferFrom') return
	return await checkSendToAddress(transferInfo.arguments.to)
}
