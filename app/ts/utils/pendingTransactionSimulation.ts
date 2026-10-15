import type { PendingTransactionOrSignableMessage, PopupPendingTransactionOrSignableMessage } from '../types/accessRequest.js'

// A gas edit is saved before resimulation completes. Never approve using results for the previous gas limit.
export function isPendingTransactionGasLimitCurrent(pending: PendingTransactionOrSignableMessage | PopupPendingTransactionOrSignableMessage) {
	if (pending.type !== 'Transaction' || pending.originalRequestParameters.method !== 'eth_sendTransaction') return true
	if (pending.transactionOrMessageCreationStatus !== 'Simulated' && pending.transactionOrMessageCreationStatus !== 'FailedToSimulate') return false
	const simulatedRequest = pending.transactionToSimulate.originalRequestParameters
	return simulatedRequest.method === 'eth_sendTransaction'
		&& pending.originalRequestParameters.params[0].gas === simulatedRequest.params[0].gas
}
