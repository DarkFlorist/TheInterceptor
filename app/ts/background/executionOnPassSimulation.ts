import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { TokenPriceService } from '../simulation/services/priceEstimator.js'
import type { SimulateGovernanceContractExecution } from '../types/interceptor-messages.js'
import type { VisualizedPersonalSignRequestSafeTx } from '../types/personal-message-definitions.js'
import { serializeSimulateExecutionReply } from '../types/simulateExecutionReply.js'
import { sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { getCurrentSimulationInput, simulateGnosisSafeMetaTransaction, simulateGovernanceContractExecution } from './simulationUpdating.js'
import { getPendingTransactionsAndMessages } from './storageVariables.js'

// Simulates what a governance proposal or a Gnosis Safe transaction does once it executes, and publishes the result to open popups.

export async function simulateGovernanceContractExecutionOnPass(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, request: SimulateGovernanceContractExecution) {
	const pendingTransactions = await getPendingTransactionsAndMessages()
	const transaction = pendingTransactions.find((tx) => tx.type === 'Transaction' && tx.transactionIdentifier === request.data.transactionIdentifier)
	if (transaction === undefined || transaction.type !== 'Transaction') throw new Error(`Could not find transactionIdentifier: ${ request.data.transactionIdentifier }`)
	const governanceContractExecutionVisualisation = await simulateGovernanceContractExecution(transaction, ethereum, tokenPriceService)
	const reply = {
		method: 'popup_simulateExecutionReply' as const,
		data: { ...governanceContractExecutionVisualisation, transactionOrMessageIdentifier: request.data.transactionIdentifier }
	}
	await sendPopupMessageToOpenWindows(serializeSimulateExecutionReply(reply))
	return reply
}

export async function simulateGnosisSafeTransactionOnPass(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, gnosisSafeMessage: VisualizedPersonalSignRequestSafeTx) {
	const gnosisTransactionExecutionVisualisation = await simulateGnosisSafeMetaTransaction(gnosisSafeMessage, await getCurrentSimulationInput(), ethereum, tokenPriceService)
	const reply = {
		method: 'popup_simulateExecutionReply' as const,
		data: { ...gnosisTransactionExecutionVisualisation, transactionOrMessageIdentifier: gnosisSafeMessage.messageIdentifier }
	}
	await sendPopupMessageToOpenWindows(serializeSimulateExecutionReply(reply))
	return reply
}
