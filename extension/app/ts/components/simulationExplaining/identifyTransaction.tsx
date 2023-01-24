import { get4Byte } from '../../utils/calldata.js'
import { CHAINS, FourByteExplanations, isSupportedChain, MAKE_YOU_RICH_TRANSACTION } from '../../utils/constants.js'
import { AddressBookEntry } from '../../utils/user-interface-types.js'
import { SimulatedAndVisualizedTransaction } from '../../utils/visualizer-types.js'
import { getSwapName, identifySwap } from './SwapTransactions.js'

type TRANSACTION_TYPE = 'MakeYouRichTransaction' | 'NormalTransaction'

export function nameTransaction(transaction: SimulatedAndVisualizedTransaction, addressMetadata: Map<string, AddressBookEntry>, activeAddress: bigint ) {
	if (identifyTransaction(transaction, activeAddress) === 'MakeYouRichTransaction') {
		return 'Simply making you rich'
	}
	if (transaction.signedTransaction.input.length == 0) return 'Ether Transfer'

	const identifiedSwap = identifySwap(transaction)
	if (identifiedSwap) return getSwapName(identifiedSwap, addressMetadata)

	const fourByte = get4Byte(transaction.signedTransaction.input)
	if (fourByte === undefined) return 'Contract Fallback Method'
	const explanation = FourByteExplanations.get(fourByte)
	return explanation !== undefined ? explanation : 'Contract Execution'
}

export function identifyTransaction(simulatedAndVisualizedTransaction: SimulatedAndVisualizedTransaction, activeAddress: bigint): TRANSACTION_TYPE {
	if (simulatedAndVisualizedTransaction.unsignedTransaction.chainId === undefined) return 'NormalTransaction'

	const chainString = simulatedAndVisualizedTransaction.unsignedTransaction.chainId.toString()
	if (!isSupportedChain(chainString)) return 'NormalTransaction'
	if (CHAINS[chainString].eth_donator === simulatedAndVisualizedTransaction.unsignedTransaction.from
		&& simulatedAndVisualizedTransaction.unsignedTransaction.to === activeAddress
		&& simulatedAndVisualizedTransaction.unsignedTransaction.type === MAKE_YOU_RICH_TRANSACTION.type
		&& simulatedAndVisualizedTransaction.unsignedTransaction.maxFeePerGas === MAKE_YOU_RICH_TRANSACTION.maxFeePerGas
		&& simulatedAndVisualizedTransaction.unsignedTransaction.maxPriorityFeePerGas === MAKE_YOU_RICH_TRANSACTION.maxPriorityFeePerGas
		&& simulatedAndVisualizedTransaction.unsignedTransaction.input.toString() === MAKE_YOU_RICH_TRANSACTION.input.toString()
		&& simulatedAndVisualizedTransaction.unsignedTransaction.value === MAKE_YOU_RICH_TRANSACTION.value
	) {
		return 'MakeYouRichTransaction'
	}
	return 'NormalTransaction'
}
