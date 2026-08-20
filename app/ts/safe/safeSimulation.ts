import { DEFAULT_BLOCK_MANIPULATION } from '../config/defaults.js'
import type { InterceptorTransactionStack, PreSimulationTransaction, SimulationStateInput, WebsiteCreatedEthereumTransaction } from '../types/visualizer-types.js'
import type { EthereumSendableSignedTransaction } from '../types/wire-types.js'
import type { SafeTransactionSigningRequest } from '../types/safeTypes.js'
import { getSignedTransactionForSimulation } from '../simulation/services/simulationTransactionSigning.js'

export function createSafeSigningSimulationInput(
	transactionStack: InterceptorTransactionStack,
	safeSigningRequest: SafeTransactionSigningRequest,
): SimulationStateInput {
	const requiredChainId = safeSigningRequest.safeTx.domain.chainId
	if (requiredChainId === undefined) throw new Error('Gnosis Safe optimistic simulation requires an EIP-712 chain ID.')
	const transactions = transactionStack.operations.flatMap((operation) => {
		if (operation.type !== 'Transaction') return []
		const transaction = operation.preSimulationTransaction
		const storedSafeTransaction = transaction.safeTransaction
		if (storedSafeTransaction === undefined) return []
		if (transaction.simulationOptions?.requiredChainId !== requiredChainId) return []
		if (storedSafeTransaction.safeTx.domain.verifyingContract !== safeSigningRequest.safeAddress) return []
		if (storedSafeTransaction.safeTx.message.nonce >= safeSigningRequest.safeTx.message.nonce) return []
		return [transaction]
	})
	if (transactions.length === 0) return []
	return [{
		stateOverrides: {},
		transactions,
		signedMessages: [],
		blockTimeManipulation: DEFAULT_BLOCK_MANIPULATION,
		simulateWithZeroBaseFee: true,
	}]
}

function createSafeExecutionSimulationTransaction(
	transactionToSimulate: WebsiteCreatedEthereumTransaction,
	safeSigningRequest: SafeTransactionSigningRequest,
): EthereumSendableSignedTransaction {
	const transaction = getSignedTransactionForSimulation(transactionToSimulate)
	if (transaction.type !== '1559') {
		throw new Error('Gnosis Safe optimistic simulation requires an EIP-1559 transaction.')
	}
	return {
		type: '1559',
		from: safeSigningRequest.safeAddress,
		chainId: transaction.chainId,
		nonce: transaction.nonce,
		maxFeePerGas: 0n,
		maxPriorityFeePerGas: 0n,
		gas: safeSigningRequest.executionGasLimit ?? transaction.gas,
		to: safeSigningRequest.safeTx.message.to,
		value: safeSigningRequest.safeTx.message.value,
		input: safeSigningRequest.safeTx.message.data,
		accessList: [],
		r: 0n,
		s: 0n,
		yParity: 'even',
		hash: safeSigningRequest.safeTxHash,
	}
}

export function createSafeExecutionPreSimulationTransaction(
	transactionToSimulate: WebsiteCreatedEthereumTransaction,
	safeSigningRequest: SafeTransactionSigningRequest,
): PreSimulationTransaction {
	const requiredChainId = safeSigningRequest.safeTx.domain.chainId
	if (requiredChainId === undefined) throw new Error('Gnosis Safe optimistic simulation requires an EIP-712 chain ID.')
	const signedTransaction = createSafeExecutionSimulationTransaction(transactionToSimulate, safeSigningRequest)
	return {
		signedTransaction,
		website: transactionToSimulate.website,
		created: transactionToSimulate.created,
		originalRequestParameters: transactionToSimulate.originalRequestParameters,
		transactionIdentifier: transactionToSimulate.transactionIdentifier,
		simulationOptions: {
			requiredChainId,
			simulateWithZeroBaseFee: true,
		},
		safeTransaction: {
			safeTx: safeSigningRequest.safeTx,
			safeTxHash: safeSigningRequest.safeTxHash,
			created: transactionToSimulate.created,
			websiteOrigin: transactionToSimulate.website.websiteOrigin,
			transactionIdentifier: transactionToSimulate.transactionIdentifier,
			signatures: [],
		},
	}
}
