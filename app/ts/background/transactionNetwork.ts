import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { PendingTransaction, PendingTransactionOrSignableMessage, SimulatedPendingTransaction } from '../types/accessRequest.js'
import { METAMASK_ERROR_NOT_CONNECTED_TO_APPROPRIATE_CHAIN } from '../utils/constants.js'
import { getActiveNetworkWrites, getSettings } from './settings.js'
import { updateInterceptorTransactionStack, updateTransactionState } from './storageVariables.js'

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

export type RequestedNetworkCommit<T> = { readonly committed: true, readonly result: T } | { readonly committed: false, readonly refusal: TransactionNetworkError }

// Whether a guarded write or delivery starts, is refused, or must read the active network again because a write of it was running when it was read, or started since.
export type RequestedNetworkVerdict = { readonly verdict: 'start' } | { readonly verdict: 'refuse', readonly refusal: TransactionNetworkError } | { readonly verdict: 'readAgain' }

// Reads the active network and returns the synchronous check against it, which a guarded write or delivery calls in the same synchronous step in which it starts. The check compares the counts of getActiveNetworkWrites, which every write of the active network updates, with those from before the read, so a 'start' verdict means that the network read is still the stored active network, and that it, the client and the stored preview match the requested network when the write or delivery starts. It cannot tell which network an external wallet signs on, because the forwarded request carries no chain id and a wallet can switch networks before the Interceptor learns of it. Signable messages carry no requested network, so they are never refused.
export async function readRequestedNetworkCheck(ethereum: EthereumClientService, pending: PendingTransactionOrSignableMessage): Promise<() => RequestedNetworkVerdict> {
	const writesBeforeRead = getActiveNetworkWrites()
	const activeChainId = (await getSettings()).activeRpcNetwork.chainId
	return () => {
		if (writesBeforeRead.started !== writesBeforeRead.finished || getActiveNetworkWrites().started !== writesBeforeRead.started) return { verdict: 'readAgain' }
		const refusal = pending.type === 'Transaction' ? getTransactionNetworkError(activeChainId, ethereum, pending) : undefined
		return refusal === undefined ? { verdict: 'start' } : { verdict: 'refuse', refusal }
	}
}

// Only this module's own writes are passed here, so a caller of the guarded writes below supplies data alone and has no code between the check and the queued write.
async function startOnRequestedNetwork<T>(ethereum: EthereumClientService, pending: PendingTransaction, start: () => Promise<T>): Promise<RequestedNetworkCommit<T>> {
	while (true) {
		const check = await readRequestedNetworkCheck(ethereum, pending)
		const verdict = check()
		if (verdict.verdict === 'refuse') return { committed: false, refusal: verdict.refusal }
		if (verdict.verdict === 'start') return { committed: true, result: await start() }
	}
}

// Queues the update on the transaction state lock in the same synchronous step as the passed check, so the stack reset of a later network switch, which takes the same lock, is applied after it. The update itself runs later, under the lock, and is synchronous.
export const updateTransactionStateOnRequestedNetwork = async (ethereum: EthereumClientService, pending: PendingTransaction, update: Parameters<typeof updateTransactionState>[0]) => await startOnRequestedNetwork(ethereum, pending, () => updateTransactionState(update))

export const updateInterceptorTransactionStackOnRequestedNetwork = async (ethereum: EthereumClientService, pending: PendingTransaction, update: Parameters<typeof updateInterceptorTransactionStack>[0]) => await startOnRequestedNetwork(ethereum, pending, () => updateInterceptorTransactionStack(update))
