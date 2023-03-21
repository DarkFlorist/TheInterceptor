import { get4Byte } from '../../utils/calldata.js'
import { CHAINS, FourByteExplanations, isSupportedChain, MAKE_YOU_RICH_TRANSACTION } from '../../utils/constants.js'
import { AddressBookEntry } from '../../utils/user-interface-types.js'
import { SimulatedAndVisualizedTransaction, TokenVisualizerResultWithMetadata } from '../../utils/visualizer-types.js'
import { getSwapName, identifySwap } from './SwapTransactions.js'

type IdentifiedTransactionBase = {
	title: string
	signingAction: string
	simulationAction: string
	rejectAction: string
}

type IdentifiedTransaction =
	IdentifiedTransactionBase & { type: 'SimpleTokenApproval', identifiedTransaction: SimulatedAndVisualizedSimpleApprovalTransaction }
	| IdentifiedTransactionBase & { type: 'EtherTransfer', identifiedTransaction: SimulatedAndVisualizedEtherTransferTransaction }
	| IdentifiedTransactionBase & { type: 'SimpleTokenTransfer', identifiedTransaction: SimulatedAndVisualizedSimpleTokenTransferTransaction }
	| IdentifiedTransactionBase & { type: 'Swap' }
	| IdentifiedTransactionBase & { type: 'ContractFallbackMethod' }
	| IdentifiedTransactionBase & { type: 'ArbitaryContractExecution' }
	| IdentifiedTransactionBase & { type: 'MakeYouRichTransaction' }
	| IdentifiedTransactionBase & { type: 'ContractDeployment' }

export function identifySimpleApproval(transaction: SimulatedAndVisualizedTransaction) {
	if (isSimpleTokenApproval(transaction)) {
		const tokenResult = transaction.tokenResults[0]
		const symbol = tokenResult.token.symbol
		if (!tokenResult.is721) {
			return {
				type: 'SimpleTokenApproval' as const,
				title: `${ symbol } Approval`,
				signingAction: `Approve ${ symbol }`,
				simulationAction: `Simulate ${ symbol } Approval`,
				rejectAction: `Reject ${ symbol } Approval`,
				identifiedTransaction: transaction,
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
					identifiedTransaction: transaction,
				}
			}
			return {
				type: 'SimpleTokenApproval' as const,
				title: `Remove ${ symbol } All Approval`,
				signingAction: `Remove ALL Approval Removal for ${ symbol }`,
				simulationAction: `Simulate Removal of All Approval for ${ symbol }`,
				rejectAction: `Reject All Approval Removal`,
				identifiedTransaction: transaction,
			}
		}

		return {
			type: 'SimpleTokenApproval' as const,
			title: `#${ tokenResult.tokenId } ${ symbol } Approval`,
			signingAction: `Approve #${ tokenResult.tokenId } ${ symbol }`,
			simulationAction: `Simulate #${ tokenResult.tokenId } ${ symbol } Approval`,
			rejectAction: `Reject #${ tokenResult.tokenId } ${ symbol } Approval`,
			identifiedTransaction: transaction,
		}
	}
	return undefined
}

export type SimulatedAndVisualizedSimpleApprovalTransaction = SimulatedAndVisualizedTransaction & {
	to: AddressBookEntry
	value: 0n
	tokenResults: [TokenVisualizerResultWithMetadata & { isApproval: true }]
}

export function isSimpleTokenApproval(transaction: SimulatedAndVisualizedTransaction): transaction is SimulatedAndVisualizedSimpleApprovalTransaction {
	if (! (transaction.value === 0n
		&& transaction.tokenResults.length === 1
		&& transaction.tokenResults[0].isApproval == true
		&& transaction.tokenResults[0].from.address !== transaction.tokenResults[0].to.address
		&& transaction.tokenResults[0].from === transaction.from
	)) return false
	return true
}

export type SimulatedAndVisualizedEtherTransferTransaction = SimulatedAndVisualizedTransaction & {
	to: AddressBookEntry
	input: []
	tokenResults: []
}

export function isEtherTransfer(transaction: SimulatedAndVisualizedTransaction): transaction is SimulatedAndVisualizedEtherTransferTransaction {
	if (transaction.input.length == 0
		&& transaction.tokenResults.length == 0
		&& transaction.gasSpent == 21000n) return true
	return false
}

export type SimulatedAndVisualizedSimpleTokenTransferTransaction = SimulatedAndVisualizedTransaction & {
	to: AddressBookEntry
	value: 0n
	tokenResults: [TokenVisualizerResultWithMetadata & { isApproval: false }]
}

export function isSimpleTokenTransfer(transaction: SimulatedAndVisualizedTransaction): transaction is SimulatedAndVisualizedSimpleTokenTransferTransaction {
	if ( transaction.value === 0n
		&& transaction.tokenResults.length === 1
		&& transaction.tokenResults[0].isApproval == false
		&& transaction.tokenResults[0].from.address !== transaction.tokenResults[0].to.address
		&& transaction.tokenResults[0].from === transaction.from) return true
	return false
}

export function identifyTransaction(transaction: SimulatedAndVisualizedTransaction, activeAddress: bigint): IdentifiedTransaction {
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

	if (isEtherTransfer(transaction)) return {
		type: 'EtherTransfer',
		title: 'Ether Transfer',
		signingAction: 'Transfer Ether',
		simulationAction: 'Simulate Ether Transfer',
		rejectAction: 'Reject Ether Transfer',
		identifiedTransaction: transaction,
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

	if (isSimpleTokenTransfer(transaction)) {
		const symbol = transaction.tokenResults[0].token.symbol
		return {
			type: 'SimpleTokenTransfer',
			title: `${ symbol } Transfer`,
			signingAction: `Transfer ${ symbol }`,
			simulationAction: `Simulate ${ symbol } Transfer`,
			rejectAction: `Reject ${ symbol } Transfer`,
			identifiedTransaction: transaction
		}
	}

	if (transaction.to === undefined) {
		return {
			type: 'ContractDeployment',
			title: `Contract Deployment`,
			signingAction: `Deploy Contract`,
			simulationAction: `Simulate Contract Deployment`,
			rejectAction: `Reject Contract Deployment`,
		}
	}

	const simpleApproval = identifySimpleApproval(transaction)
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
