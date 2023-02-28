import { get4Byte } from '../../utils/calldata.js'
import { CHAINS, FourByteExplanations, isSupportedChain, MAKE_YOU_RICH_TRANSACTION } from '../../utils/constants.js'
import { SimulatedAndVisualizedTransaction } from '../../utils/visualizer-types.js'
import { getSwapName, identifySwap } from './SwapTransactions.js'

type TRANSACTION_TYPE = 'MakeYouRichTransaction'
	| 'ArbitaryContractExecution'
	| 'EtherTransfer'
	| 'Swap'
	| 'ContractFallbackMethod'
	| 'SimpleTokenTransfer'
	| 'SimpleTokenApproval'

type IdenttifiedTransaction = {
	type: TRANSACTION_TYPE,
	title: string,
	signingAction: string,
	simulationAction: string,
	rejectAction: string,
}

export function checkSimpleTokenApproval(transaction: SimulatedAndVisualizedTransaction) {
	if (! (transaction.value === 0n
		&& transaction.tokenResults.length === 1
		&& transaction.tokenResults[0].isApproval == true
		&& transaction.tokenResults[0].from.address !== transaction.tokenResults[0].to.address
		&& transaction.tokenResults[0].from === transaction.from
	)) return undefined

	const tokenResult = transaction.tokenResults[0]
	const symbol = tokenResult.token.symbol
	if (!tokenResult.is721) {
		return {
			type: 'SimpleTokenApproval' as const,
			title: `${ symbol } Approval`,
			signingAction: `Approve ${ symbol }`,
			simulationAction: `Simulate ${ symbol } Approval`,
			rejectAction: `Reject ${ symbol } Approval`,
		}
	}
	if ('isAllApproval' in tokenResult) {
		if (tokenResult.allApprovalAdded) {
			return {
				type: 'SimpleTokenApproval' as const,
				title: `${ symbol } ALL Approval`,
				signingAction: `Approve ALL ${ symbol }`,
				simulationAction: `Simulate ${ symbol } ALL Approval`,
				rejectAction: `Reject ${ symbol } ALL Approval`,
			}
		}
		return {
			type: 'SimpleTokenApproval' as const,
			title: `Remove ${ symbol } All Approval`,
			signingAction: `Remove ALL Approval Removal for ${ symbol }`,
			simulationAction: `Simulate Removal of All Approval for ${ symbol }`,
			rejectAction: `Reject All Approval Removal`,
		}
	}

	return {
		type: 'SimpleTokenApproval' as const,
		title: `#${ tokenResult.tokenId } ${ symbol } Approval`,
		signingAction: `Approve #${ tokenResult.tokenId } ${ symbol }`,
		simulationAction: `Simulate #${ tokenResult.tokenId } ${ symbol } Approval`,
		rejectAction: `Reject #${ tokenResult.tokenId } ${ symbol } Approval`,
	}
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

	if (transaction.input.length == 0 && transaction.tokenResults.length == 0 && transaction.gasSpent == 21000n) return {
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

	const simpleApproval = checkSimpleTokenApproval(transaction)
	if (simpleApproval !== undefined) return simpleApproval

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
