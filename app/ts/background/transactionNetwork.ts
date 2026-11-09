import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { PendingTransaction, PendingTransactionOrSignableMessage, SimulatedPendingTransaction } from '../types/accessRequest.js'
import { readActiveNetworkSnapshot } from './activeNetworkStorage.js'
import { getInstalledSimulationServices } from './installedSimulationServices.js'
import { updateInterceptorTransactionStack, updateTransactionState } from './storageVariables.js'

// A transaction is only prepared, simulated and visualized with the client of the network it was requested for. After a network switch its preview is kept unchanged, and approval is refused until the user switches back.
export const isEthereumClientOnTransactionChain = (ethereum: EthereumClientService, pendingTransaction: PendingTransaction) => ethereum.getChainId() === pendingTransaction.requestedChainId

// The same contract address can behave differently on another network, so the transaction and the visualized simulation must come from the requested network. The chain id of an eth_sendTransaction is the one the Interceptor prepared, and that of an eth_sendRawTransaction is the one the website signed, which must match too, or a raw transaction signed for another network would be previewed here and broadcast there. A failed simulation, which can still be force-sent, records no network.
function isTransactionPreviewOnRequestedChain(pendingTransaction: Extract<SimulatedPendingTransaction, { readonly transactionOrMessageCreationStatus: 'Simulated' }>, requestedChainId: bigint) {
	const { popupVisualisation, transactionToSimulate } = pendingTransaction
	// Supported raw transactions require a chain id: parseSendRawTransaction rejects every legacy transaction, including a pre-EIP-155 one without a chain id, before it is ever pending.
	if (transactionToSimulate.transaction.chainId !== requestedChainId) return false
	return popupVisualisation.statusCode !== 'success' || popupVisualisation.data.simulationState.rpcNetwork.chainId === requestedChainId
}

const createNetworkRefusal = (reason: string) => ({ message: `${ reason } Reject this transaction and send the request again.` })

export type NetworkRefusal = ReturnType<typeof createNetworkRefusal>

// A transaction is never signed, added to a stack or stored on another network than it was requested and previewed on. Synchronous, so the final check can run with nothing awaited before the request is committed.
function getNetworkRefusal(activeChainId: bigint, ethereum: EthereumClientService, pendingTransaction: PendingTransaction): NetworkRefusal | undefined {
	const { requestedChainId } = pendingTransaction
	// Without a requested network no network can match, so this refusal never lifts.
	if (requestedChainId === 'unknown') return createNetworkRefusal('This transaction was requested with an older version of The Interceptor.')
	if (activeChainId !== requestedChainId || ethereum.getChainId() !== requestedChainId) return createNetworkRefusal('The active network changed after this transaction was requested.')
	// A Gnosis Safe proposal is signed as EIP-712 data whose domain names the network of the Safe.
	if (pendingTransaction.safeTransaction !== undefined && pendingTransaction.safeTransaction.safeTx.domain.chainId !== requestedChainId) return createNetworkRefusal('The Gnosis Safe transaction was prepared for another network than the transaction was requested for.')
	if (pendingTransaction.transactionOrMessageCreationStatus === 'Simulated' && !isTransactionPreviewOnRequestedChain(pendingTransaction, requestedChainId)) return createNetworkRefusal('The transaction preview was not simulated on the network the transaction was requested for.')
	return undefined
}

export type RequestedNetworkCommit<T> = { readonly committed: true, readonly result: T } | { readonly committed: false, readonly refusal: NetworkRefusal }

type RequestedNetworkVerdict = { readonly verdict: 'proceed' } | { readonly verdict: 'refuse', readonly refusal: NetworkRefusal } | { readonly verdict: 'readAgain' }

async function readRequestedNetworkCheck(ethereum: EthereumClientService, pending: PendingTransactionOrSignableMessage): Promise<() => RequestedNetworkVerdict> {
	const activeNetwork = await readActiveNetworkSnapshot()
	return () => {
		if (!activeNetwork.isStillCurrent()) return { verdict: 'readAgain' }
		const refusal = pending.type === 'Transaction' ? getNetworkRefusal(activeNetwork.activeRpcNetwork.chainId, ethereum, pending) : undefined
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

// How many times the active network is read for what the window is shown before a read that a write overlapped is used anyway. A switch writes the network once, so a second read is current unless writes keep arriving, and a refusal shown from an overlapped read is only advisory and is replaced by the queue the window asks for after the switch.
const SHOWN_REFUSAL_NETWORK_READS = 3

// What the confirmation window is shown of the requested-network rule, derived each time the queue is shown and never stored. show receives the refusal of each transaction under the stored active network and the client installed at that moment, both taken in the same synchronous step as show runs: the network is read again while a write overlapped its read, so a switch between the read and show never pairs the network from before it with the client installed after it. Showing it is advisory: every approval runs the rule itself.
export async function showWithCurrentNetworkRefusals<T>(show: (getNetworkRefusalMessage: (pending: PendingTransaction) => string | undefined) => T): Promise<T> {
	for (let read = 1; ; read++) {
		const activeNetwork = await readActiveNetworkSnapshot()
		if (!activeNetwork.isStillCurrent() && read < SHOWN_REFUSAL_NETWORK_READS) continue
		const installedEthereum = getInstalledSimulationServices().ethereum
		return show((pending) => getNetworkRefusal(activeNetwork.activeRpcNetwork.chainId, installedEthereum, pending)?.message)
	}
}

// Queues the update on the transaction state lock in the same synchronous step as the passed check, so the stack reset of a later network switch, which takes the same lock, is applied after it. The update itself runs later, under the lock, and is synchronous.
export const updateTransactionStateOnRequestedNetwork = async (ethereum: EthereumClientService, pending: PendingTransaction, update: Parameters<typeof updateTransactionState>[0]) => await proceedOnRequestedNetwork(ethereum, pending, () => updateTransactionState(update))

export const updateInterceptorTransactionStackOnRequestedNetwork = async (ethereum: EthereumClientService, pending: PendingTransaction, update: Parameters<typeof updateInterceptorTransactionStack>[0]) => await proceedOnRequestedNetwork(ethereum, pending, () => updateInterceptorTransactionStack(update))
