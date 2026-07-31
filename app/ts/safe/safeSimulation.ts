import type { PreSimulationTransaction, WebsiteCreatedEthereumTransaction } from '../types/visualizer-types.js'
import type { EthereumSendableSignedTransaction } from '../types/wire-types.js'
import type { SafeTransactionSigningRequest } from '../types/safeTypes.js'
import { getSignedTransactionForSimulation } from '../simulation/services/SimulationModeEthereumClientService.js'

export function createSafeExecutionSimulationTransaction(
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
	return {
		signedTransaction: createSafeExecutionSimulationTransaction(transactionToSimulate, safeSigningRequest),
		website: transactionToSimulate.website,
		created: transactionToSimulate.created,
		originalRequestParameters: transactionToSimulate.originalRequestParameters,
		transactionIdentifier: transactionToSimulate.transactionIdentifier,
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
