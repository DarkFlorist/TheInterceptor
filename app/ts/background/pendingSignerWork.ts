import type { PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import type { WebsiteTabConnections, PendingChainChangeConfirmationPromise } from '../types/user-interface-types.js'
import { runWithSignerSelectionGate } from './signerSelectionLease.js'
import { updatePendingTransactionOrMessages, writeChainChangeConfirmation } from './storageVariables.js'

// Creation enters the signer workflow through these operations, so callers cannot omit or nest its selection reservation.
export async function appendPendingTransactionOrMessage(websiteTabConnections: WebsiteTabConnections, pending: PendingTransactionOrSignableMessage) {
	await runWithSignerSelectionGate(websiteTabConnections, pending.uniqueRequestIdentifier.requestSocket.tabId, async () => await updatePendingTransactionOrMessages(async (previous) => [...previous, pending]))
}

export async function setChainChangeConfirmationPromise(websiteTabConnections: WebsiteTabConnections, pending: PendingChainChangeConfirmationPromise | undefined) {
	// Removing work cannot introduce a selection conflict and must not wait behind an active selection.
	if (pending === undefined) return await writeChainChangeConfirmation(undefined)
	return await runWithSignerSelectionGate(websiteTabConnections, pending.request.uniqueRequestIdentifier.requestSocket.tabId, async () => await writeChainChangeConfirmation(pending))
}
