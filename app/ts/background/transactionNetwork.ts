import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { PendingTransaction, PendingTransactionOrSignableMessage, SimulatedPendingTransaction } from '../types/accessRequest.js'
import type { InterceptedRequestForward } from '../types/interceptor-messages.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { METAMASK_ERROR_NOT_CONNECTED_TO_APPROPRIATE_CHAIN } from '../utils/constants.js'
import { attemptDeliveryAfterManifestV2Reconnect } from './manifestV2Reconnect.js'
import { replyToInterceptedRequest } from './messageSending.js'
import { getSettings } from './settings.js'

// A transaction is only prepared, simulated and visualized with the client of the network it was requested for. After a network switch its preview is kept unchanged, and approval is refused until the user switches back.
export const isEthereumClientOnTransactionChain = (ethereum: EthereumClientService, pendingTransaction: PendingTransaction) => ethereum.getChainId() === pendingTransaction.requestedChainId

// The same contract address can behave differently on another network, so the transaction the Interceptor prepared and the visualized simulation must come from the requested network. A raw transaction keeps the network its sender signed it for, and a failed simulation, which can still be force-sent, records no network.
function isTransactionPreviewOnRequestedChain(pendingTransaction: Extract<SimulatedPendingTransaction, { readonly transactionOrMessageCreationStatus: 'Simulated' }>, requestedChainId: bigint) {
	const { popupVisualisation, transactionToSimulate } = pendingTransaction
	if (pendingTransaction.originalRequestParameters.method === 'eth_sendTransaction' && transactionToSimulate.transaction.chainId !== requestedChainId) return false
	return popupVisualisation.statusCode !== 'success' || popupVisualisation.data.simulationState.rpcNetwork.chainId === requestedChainId
}

const transactionApprovalInvalidated = (reason: string) => ({ status: 'SignerError' as const, code: METAMASK_ERROR_NOT_CONNECTED_TO_APPROPRIATE_CHAIN, message: `${ reason } Reject this transaction and send the request again.` })

export type TransactionNetworkError = ReturnType<typeof transactionApprovalInvalidated>

// A transaction is never signed, added to a stack or stored on another network than it was requested and previewed on. Synchronous, so the final check can run with nothing awaited before the request is committed.
function getTransactionNetworkError(activeChainId: bigint, ethereum: EthereumClientService, pendingTransaction: PendingTransaction): TransactionNetworkError | undefined {
	const { requestedChainId } = pendingTransaction
	if (requestedChainId === undefined || activeChainId !== requestedChainId || ethereum.getChainId() !== requestedChainId) return transactionApprovalInvalidated('The active network changed after this transaction was requested.')
	// A Gnosis Safe proposal is signed as EIP-712 data whose domain names the network of the Safe.
	if (pendingTransaction.safeTransaction !== undefined && pendingTransaction.safeTransaction.safeTx.domain.chainId !== requestedChainId) return transactionApprovalInvalidated('The Gnosis Safe transaction was prepared for another network than the transaction was requested for.')
	if (pendingTransaction.transactionOrMessageCreationStatus === 'Simulated' && !isTransactionPreviewOnRequestedChain(pendingTransaction, requestedChainId)) return transactionApprovalInvalidated('The transaction preview was not simulated on the network the transaction was requested for.')
	return undefined
}

export const getTransactionNetworkApprovalError = async (ethereum: EthereumClientService, pendingTransaction: PendingTransaction) => getTransactionNetworkError((await getSettings()).activeRpcNetwork.chainId, ethereum, pendingTransaction)

type NetworkCheckedCommit<T> = { readonly committed: true, readonly result: T } | { readonly committed: false, readonly networkError: TransactionNetworkError }

// The last step before a transaction is forwarded to the signer, added to the simulation stack or stored in a Gnosis Safe stack, started with nothing awaited after the network check, so a network switch either finished before the check or applies after the commit posted its request or queued its storage update. This guarantees that the Interceptor's active network, its client and the stored preview match the requested network at every commit or delivery attempt; it cannot guarantee the network an external wallet signs on, because the forwarded request carries no chain id and a wallet can switch networks before the Interceptor learns of it. Signable messages carry no requested network, so they are committed unchecked.
export async function commitOnRequestedNetwork<T>(ethereum: EthereumClientService, pending: PendingTransactionOrSignableMessage, commit: () => Promise<T>): Promise<NetworkCheckedCommit<T>> {
	const activeChainId = (await getSettings()).activeRpcNetwork.chainId
	const networkError = pending.type === 'Transaction' ? getTransactionNetworkError(activeChainId, ethereum, pending) : undefined
	if (networkError !== undefined) return { committed: false, networkError }
	return { committed: true, result: await commit() }
}

// Forwards an approved request to the signer with the network checked right before every delivery attempt, including the retry after a Manifest V2 content script reconnect, which can outlast a network switch.
export async function forwardOnRequestedNetwork(ethereum: EthereumClientService, websiteTabConnections: WebsiteTabConnections, pending: PendingTransactionOrSignableMessage, message: InterceptedRequestForward): Promise<NetworkCheckedCommit<boolean | undefined>> {
	const refusedAttempts: TransactionNetworkError[] = []
	const delivered = await attemptDeliveryAfterManifestV2Reconnect(websiteTabConnections, message, async () => {
		const attempt = await commitOnRequestedNetwork(ethereum, pending, async () => replyToInterceptedRequest(websiteTabConnections, message))
		if (attempt.committed) return attempt.result
		refusedAttempts.push(attempt.networkError)
		// Only a false result makes the reconnect helper retry, so a refused attempt ends the delivery.
		return undefined
	})
	const [networkError] = refusedAttempts
	return networkError === undefined ? { committed: true, result: delivered } : { committed: false, networkError }
}
