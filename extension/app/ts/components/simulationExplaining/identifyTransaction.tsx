import { get4Byte } from '../../utils/calldata.js'
import { CHAINS, FourByteExplanations, isSupportedChain, MAKE_YOU_RICH_TRANSACTION } from '../../utils/constants.js'
import { SimulatedAndVisualizedTransaction } from '../../utils/visualizer-types.js'
import { getSwapName, identifySwap } from './SwapTransactions.js'

type TRANSACTION_TYPE = 'MakeYouRichTransaction' | 'NormalTransaction'

export function nameTransaction(transaction: SimulatedAndVisualizedTransaction, activeAddress: bigint ) {
	if (identifyTransaction(transaction, activeAddress) === 'MakeYouRichTransaction') {
		return 'Simply making you rich'
	}
	if (transaction.input.length == 0) return 'Ether Transfer'

	//TODO: add simple token transfer

	const identifiedSwap = identifySwap(transaction)
	if (identifiedSwap) return getSwapName(identifiedSwap, transaction.chainId)

	const fourByte = get4Byte(transaction.input)
	if (fourByte === undefined) return 'Contract Fallback Method'
	const explanation = FourByteExplanations.get(fourByte)
	return explanation !== undefined ? explanation : 'Contract Execution'
}


export function nameTransactionAction(transaction: SimulatedAndVisualizedTransaction, activeAddress: bigint ) {
	if (identifyTransaction(transaction, activeAddress) === 'MakeYouRichTransaction') {
		return 'Rich'
	}
	if (transaction.input.length == 0) return 'Ether Transfer'

	//TODO: add simple token transfer

	const identifiedSwap = identifySwap(transaction)
	if (identifiedSwap) return 'Swap'

	const fourByte = get4Byte(transaction.input)
	if (fourByte === undefined) return 'Contract Fallback'
	const explanation = FourByteExplanations.get(fourByte)
	return explanation !== undefined ? explanation : 'Execute Contract'
}

export function identifyTransaction(transaction: SimulatedAndVisualizedTransaction, activeAddress: bigint): TRANSACTION_TYPE {
	const chainString = transaction.chainId.toString()
	if (!isSupportedChain(chainString)) return 'NormalTransaction'
	if (CHAINS[chainString].eth_donator === transaction.from.address
		&& transaction.to?.address === activeAddress
		&& transaction.type === MAKE_YOU_RICH_TRANSACTION.type
		&& transaction.maxFeePerGas === MAKE_YOU_RICH_TRANSACTION.maxFeePerGas
		&& transaction.maxPriorityFeePerGas === MAKE_YOU_RICH_TRANSACTION.maxPriorityFeePerGas
		&& transaction.input.toString() === MAKE_YOU_RICH_TRANSACTION.input.toString()
		&& transaction.value === MAKE_YOU_RICH_TRANSACTION.value
	) {
		return 'MakeYouRichTransaction'
	}
	return 'NormalTransaction'
}
