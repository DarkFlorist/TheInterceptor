import { get4Byte } from '../../utils/calldata.js'
import { CHAINS, FourByteExplanations, isSupportedChain, MAKE_YOU_RICH_TRANSACTION } from '../../utils/constants.js'
import { SimulatedAndVisualizedTransaction } from '../../utils/visualizer-types.js'
import { getSwapName, identifySwap } from './SwapTransactions.js'

type TRANSACTION_TYPE = 'MakeYouRichTransaction' | 'ArbitaryContractExecution' | 'EtherTransfer' | 'Swap' | 'ContractFallbackMethod' | 'SimpleTokenTransfer'

type IdenttifiedTransaction = {
	type: TRANSACTION_TYPE,
	title: string,
	signingAction: string,
	simulationAction: string,
	rejectAction: string,
}

export function identifyTransaction(transaction: SimulatedAndVisualizedTransaction, activeAddress: bigint): IdenttifiedTransaction {
	const chainString = transaction.chainId.toString()
	if (isSupportedChain(chainString)
		&& CHAINS[chainString].eth_donator === transaction.from.address
		&& transaction.to?.address === activeAddress
		&& transaction.type === MAKE_YOU_RICH_TRANSACTION.type
		&& transaction.maxFeePerGas === MAKE_YOU_RICH_TRANSACTION.maxFeePerGas
		&& transaction.maxPriorityFeePerGas === MAKE_YOU_RICH_TRANSACTION.maxPriorityFeePerGas
		&& transaction.input.toString() === MAKE_YOU_RICH_TRANSACTION.input.toString()
		&& transaction.value === MAKE_YOU_RICH_TRANSACTION.value
	) {
		return {
			type: 'MakeYouRichTransaction',
			title: 'Simply making you rich',
			signingAction: 'Make me rich',
			simulationAction: 'Simulate richies',
			rejectAction: 'Reject richies',
		}
	}

	if (transaction.input.length == 0) return {
		type: 'EtherTransfer',
		title: 'Ether Transfer',
		signingAction: 'Transfer Ether',
		simulationAction: 'Simulate Ether Transfer',
		rejectAction: 'Reject Ether Transfer',
	}

	const identifiedSwap = identifySwap(transaction)
	if (identifiedSwap) {
		const swapname = getSwapName(identifiedSwap, transaction.chainId)
		return {
			type: 'Swap',
			title: swapname === undefined ? 'Swap' : swapname,
			signingAction: 'Swap',
			simulationAction: 'Simulate Swap',
			rejectAction: 'Reject Swap',
		}
	}

	if (transaction.value === 0n
		&& transaction.tokenResults.length === 1
		&& transaction.tokenResults[0].isApproval == false
		&& transaction.tokenResults[0].from.address !== transaction.tokenResults[0].to.address
		&& transaction.tokenResults[0].from === transaction.from
	) {
		const symbol = transaction.tokenResults[0].token.symbol
		return {
			type: 'SimpleTokenTransfer',
			title: `${ symbol } Transfer`,
			signingAction: `Transfer ${ symbol }`,
			simulationAction: `Simulate ${ symbol } Transfer`,
			rejectAction: `Reject ${ symbol } Transfer`,
		}
	}

	const fourByte = get4Byte(transaction.input)
	if (fourByte === undefined) return {
		type: 'ArbitaryContractExecution',
		title: 'Contract Fallback Method',
		signingAction: 'Execute Contract',
		simulationAction: 'Simulate Contract Execution',
		rejectAction: 'Reject Contract Execution',
	}

	const explanation = FourByteExplanations.get(fourByte)

	if (explanation === undefined) {
		return {
			type: 'ArbitaryContractExecution',
			title: 'Contract Execution',
			signingAction: 'Execute Contract',
			simulationAction: 'Simulate Contract Execution',
			rejectAction: 'Reject Contract Execution',
		}
	}
	return {
		type: 'ArbitaryContractExecution',
		title: explanation === undefined ? 'Contract Execution' : explanation,
		signingAction: `Sign ${ explanation }`,
		simulationAction: `Simulate ${ explanation }`,
		rejectAction: `Reject ${ explanation }`,
	}
}
