import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { SimulationServicesOwner } from '../simulation/serviceLifecycle.js'
import type { RpcEntry } from '../types/rpc.js'
import type { PendingTransaction, PendingTransactionOrSignableMessage, SimulatedPendingTransaction } from '../types/accessRequest.js'
import type { UniqueRequestIdentifier } from '../utils/requests.js'
import { modifyObject } from '../utils/typescript.js'
import { reportUnexpectedError } from '../utils/errors.js'
import { readActiveNetworkSnapshot, setAfterActiveNetworkWrite } from './activeNetworkStorage.js'
import { sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { getPendingTransactionsAndMessages, updateInterceptorTransactionStack, updatePendingTransactionOrMessage, updateTransactionState } from './storageVariables.js'

// A transaction is only prepared, simulated and visualized with the client of the network it was requested for. After a network switch its preview is kept unchanged, and approval is refused until the user switches back.
export const isEthereumClientOnTransactionChain = (ethereum: EthereumClientService, pendingTransaction: PendingTransaction) => ethereum.getChainId() === pendingTransaction.requestedChainId

// The same contract address can behave differently on another network, so the transaction and the visualized simulation must come from the requested network. The chain id of an eth_sendTransaction is the one the Interceptor prepared, and that of an eth_sendRawTransaction is the one the website signed, which must match too, or a raw transaction signed for another network would be previewed here and broadcast there. A failed simulation, which can still be force-sent, records no network.
function isTransactionPreviewOnRequestedChain(pendingTransaction: Extract<SimulatedPendingTransaction, { readonly transactionOrMessageCreationStatus: 'Simulated' }>, requestedChainId: bigint) {
	const { popupVisualisation, transactionToSimulate } = pendingTransaction
	// Supported raw transactions require a chain id: parseSendRawTransaction rejects every legacy transaction, including a pre-EIP-155 one without a chain id, before it is ever pending.
	if (transactionToSimulate.transaction.chainId !== requestedChainId) return false
	return popupVisualisation.statusCode !== 'success' || popupVisualisation.data.simulationState.rpcNetwork.chainId === requestedChainId
}

const createNetworkRefusal = (reason: string) => ({ status: 'NetworkRefusal' as const, message: `${ reason } Reject this transaction and send the request again.` })

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

const getStoredNetworkRefusalMessage = ({ approvalStatus }: PendingTransactionOrSignableMessage) => approvalStatus.status === 'NetworkRefusal' ? approvalStatus.message : undefined

// A refusal describes the network at the moment of the approval, so a stored one is replaced by what the same check says now, which lifts it once approving would work again. Only what the user is told changes: every approval runs the check itself whatever is stored, and a request that holds no refusal is never given one here. The check runs on the stored request under the lock of its writers, so the write replaces exactly the refusal that was checked and never a newer one; it reads only storage and the client's chain id, never an RPC, and a network switch after it re-evaluates again. It tells whether any stored refusal changed, as the windows then need to read it.
export async function reevaluateStoredNetworkRefusals(ethereum: EthereumClientService) {
	let refusalChanged = false
	for (const pending of await getPendingTransactionsAndMessages()) {
		if (pending.type !== 'Transaction' || getStoredNetworkRefusalMessage(pending) === undefined) continue
		await updatePendingTransactionOrMessage(pending.uniqueRequestIdentifier, async (current) => {
			const storedMessage = getStoredNetworkRefusalMessage(current)
			if (current.type !== 'Transaction' || storedMessage === undefined) return undefined
			const refusal = await getTransactionNetworkApprovalError(ethereum, current)
			if (refusal?.message === storedMessage) return undefined
			refusalChanged = true
			return modifyObject(current, { approvalStatus: refusal ?? { status: 'WaitingForUser' as const } })
		})
	}
	return refusalChanged
}

// Re-evaluates the stored refusals for a caller that goes on to tell the windows and websites of a network change, which a failure here must not stop: the failure is reported, and nothing is reported as changed.
export async function reevaluateStoredNetworkRefusalsBestEffort(ethereum: EthereumClientService) {
	try {
		return await reevaluateStoredNetworkRefusals(ethereum)
	} catch (error: unknown) {
		await reportUnexpectedError(error, { code: 'network_refusal_reevaluation_failed' })
		return false
	}
}

// Re-evaluates the stored refusals with the given client, best effort, and tells the confirmation window to read the stored requests again if one changed.
async function reevaluateStoredNetworkRefusalsAndNotifyWindow(ethereum: EthereumClientService) {
	if (await reevaluateStoredNetworkRefusalsBestEffort(ethereum)) await sendPopupMessageToOpenWindows({ method: 'popup_confirm_transaction_stored_state_changed' }, 'confirmTransaction')
}

// Called once at background startup. Every write of the active network goes through writeActiveNetwork, and from then on each one re-evaluates the stored refusals with the installed client, so a network switch, a simulation mode change, a settings import and the startup repair all update them.
export function reevaluateNetworkRefusalsAfterEveryActiveNetworkWrite(getInstalledEthereum: () => EthereumClientService) {
	setAfterActiveNetworkWrite(async () => await reevaluateStoredNetworkRefusalsAndNotifyWindow(getInstalledEthereum()))
}

// The background's one way to replace the installed client. A refusal is decided against the client that would execute the transaction, which can change while the stored network stays the same, as when a settings import stored a network without installing its client and another endpoint of that network is selected later, so every replacement re-evaluates the stored refusals with the new client.
export async function replaceInstalledSimulationServices(simulationServicesOwner: SimulationServicesOwner, rpcNetwork: RpcEntry) {
	const services = simulationServicesOwner.reset(rpcNetwork)
	await reevaluateStoredNetworkRefusalsAndNotifyWindow(services.ethereum)
	return services
}

// The one place a network refusal is stored. The refusal is the verdict of the services the approval captured, but what is stored says what approving would do now, as a resolution can outlive a network switch. The installed client is read after the refusal is stored, so a switch that finished earlier is seen here, and one that starts later finds the refusal and re-evaluates it itself before it tells the windows.
export async function storeNetworkRefusal(getInstalledEthereum: () => EthereumClientService, uniqueRequestIdentifier: UniqueRequestIdentifier, refusal: NetworkRefusal) {
	await updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (pending) => modifyObject(pending, { approvalStatus: refusal }))
	await reevaluateStoredNetworkRefusals(getInstalledEthereum())
}

// Queues the update on the transaction state lock in the same synchronous step as the passed check, so the stack reset of a later network switch, which takes the same lock, is applied after it. The update itself runs later, under the lock, and is synchronous.
export const updateTransactionStateOnRequestedNetwork = async (ethereum: EthereumClientService, pending: PendingTransaction, update: Parameters<typeof updateTransactionState>[0]) => await proceedOnRequestedNetwork(ethereum, pending, () => updateTransactionState(update))

export const updateInterceptorTransactionStackOnRequestedNetwork = async (ethereum: EthereumClientService, pending: PendingTransaction, update: Parameters<typeof updateInterceptorTransactionStack>[0]) => await proceedOnRequestedNetwork(ethereum, pending, () => updateInterceptorTransactionStack(update))
