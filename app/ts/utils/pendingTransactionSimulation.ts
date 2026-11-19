import type { PendingTransactionOrSignableMessage, PopupPendingTransactionOrSignableMessage } from '../types/accessRequest.js'

// A gas edit is saved before resimulation completes. Ordinary approval must not use results for the previous gas limit; explicit force-send is handled separately.
export function isPendingTransactionGasLimitCurrent(pending: PendingTransactionOrSignableMessage | PopupPendingTransactionOrSignableMessage) {
	if (pending.type !== 'Transaction' || pending.originalRequestParameters.method !== 'eth_sendTransaction') return true
	if (pending.transactionOrMessageCreationStatus !== 'Simulated' && pending.transactionOrMessageCreationStatus !== 'FailedToSimulate') return false
	const simulatedRequest = pending.transactionToSimulate.originalRequestParameters
	return simulatedRequest.method === 'eth_sendTransaction'
		&& pending.originalRequestParameters.params[0].gas === simulatedRequest.params[0].gas
}

// The edited gas limit of a request whose stored results are for an earlier gas limit, which a send-anyway accept sends without simulating it first.
export function getUnsimulatedGasLimitEdit(pending: PendingTransactionOrSignableMessage) {
	if (isPendingTransactionGasLimitCurrent(pending) || pending.originalRequestParameters.method !== 'eth_sendTransaction') return undefined
	return pending.originalRequestParameters.params[0].gas
}
