import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { PendingTransaction, PendingTransactionOrSignableMessage, SimulatedPendingTransaction } from '../types/accessRequest.js'
import { METAMASK_ERROR_NOT_CONNECTED_TO_APPROPRIATE_CHAIN } from '../utils/constants.js'
import { readActiveNetworkSnapshot } from './settings.js'
import { updateInterceptorTransactionStack, updateTransactionState } from './storageVariables.js'

// A transaction is only prepared, simulated and visualized with the client of the network it was requested for. After a network switch its preview is kept unchanged, and approval is refused until the user switches back.
export const isEthereumClientOnTransactionChain = (ethereum: EthereumClientService, pendingTransaction: PendingTransaction) => ethereum.getChainId() === pendingTransaction.requestedChainId

// The same contract address can behave differently on another network, so the transaction and the visualized simulation must come from the requested network. The chain id of an eth_sendTransaction is the one the Interceptor prepared, and that of an eth_sendRawTransaction is the one the website signed, which must match too, or a raw transaction signed for another network would be previewed here and broadcast there. A failed simulation, which can still be force-sent, records no network.
function isTransactionPreviewOnRequestedChain(pendingTransaction: Extract<SimulatedPendingTransaction, { readonly transactionOrMessageCreationStatus: 'Simulated' }>, requestedChainId: bigint) {
	const { popupVisualisation, transactionToSimulate } = pendingTransaction
	// Every transaction type requires a chain id; a raw transaction without one, a pre-EIP-155 legacy transaction, is rejected by parseSendRawTransaction before it is ever pending.
	if (transactionToSimulate.transaction.chainId !== requestedChainId) return false
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

export type RequestedNetworkCommit<T> = { readonly committed: true, readonly result: T } | { readonly committed: false, readonly refusal: TransactionNetworkError }

type RequestedNetworkVerdict = { readonly verdict: 'proceed' } | { readonly verdict: 'refuse', readonly refusal: TransactionNetworkError } | { readonly verdict: 'readAgain' }

async function readRequestedNetworkCheck(ethereum: EthereumClientService, pending: PendingTransactionOrSignableMessage): Promise<() => RequestedNetworkVerdict> {
	const activeNetwork = await readActiveNetworkSnapshot()
	return () => {
		if (!activeNetwork.isStillCurrent()) return { verdict: 'readAgain' }
		const refusal = pending.type === 'Transaction' ? getTransactionNetworkError(activeNetwork.activeRpcNetwork.chainId, ethereum, pending) : undefined
		return refusal === undefined ? { verdict: 'proceed' } : { verdict: 'refuse', refusal }
	}
}

// Reads the active network until it is still the stored active network when checked, then either refuses or calls proceed in the same synchronous step as the passing check. A passing check means the stored active network, the client and the stored preview match the requested network at that step; it cannot tell which network an external wallet signs on, because the forwarded request carries no chain id and a wallet can switch networks before the Interceptor learns of it. Signable messages carry no requested network, so they are never refused. The guarded writes below and the guarded delivery in requestedNetworkForwarding.ts pass their own write or post as proceed, so their callers pass data only.
export async function proceedOnRequestedNetwork<T>(ethereum: EthereumClientService, pending: PendingTransactionOrSignableMessage, proceed: () => T | Promise<T>): Promise<RequestedNetworkCommit<T>> {
	while (true) {
		const check = await readRequestedNetworkCheck(ethereum, pending)
		const verdict = check()
		if (verdict.verdict === 'refuse') return { committed: false, refusal: verdict.refusal }
		if (verdict.verdict === 'proceed') return { committed: true, result: await proceed() }
	}
}

// The early check of an approval, which refuses it before any Gnosis Safe refresh or signer status change; the guarded write or delivery checks again when it starts.
export async function getTransactionNetworkApprovalError(ethereum: EthereumClientService, pendingTransaction: PendingTransaction) {
	const approval = await proceedOnRequestedNetwork(ethereum, pendingTransaction, () => undefined)
	return approval.committed ? undefined : approval.refusal
}

// Queues the update on the transaction state lock in the same synchronous step as the passed check, so the stack reset of a later network switch, which takes the same lock, is applied after it. The update itself runs later, under the lock, and is synchronous.
export const updateTransactionStateOnRequestedNetwork = async (ethereum: EthereumClientService, pending: PendingTransaction, update: Parameters<typeof updateTransactionState>[0]) => await proceedOnRequestedNetwork(ethereum, pending, () => updateTransactionState(update))

export const updateInterceptorTransactionStackOnRequestedNetwork = async (ethereum: EthereumClientService, pending: PendingTransaction, update: Parameters<typeof updateInterceptorTransactionStack>[0]) => await proceedOnRequestedNetwork(ethereum, pending, () => updateInterceptorTransactionStack(update))
