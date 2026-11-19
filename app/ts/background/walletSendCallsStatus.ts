import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { getSimulatedTransactionReceipt } from '../simulation/services/SimulationModeEthereumClientService.js'
import type { RPCReply } from '../types/interceptor-messages.js'
import { WALLET_SEND_CALLS_VERSION, type WalletCallsReceipt, type WalletGetCallsStatus } from '../types/JsonRpc-types.js'
import type { ResolvedExecutionSimulationState } from '../types/visualizer-types.js'
import { JsonRpcResponseError } from '../utils/errors.js'
import { getCallsStatusCode, walletSendCallsUnknownBundleIdError } from './walletSendCalls.js'
import { getWalletSendCallsBundleForRequester } from './walletSendCallsBatchIds.js'
import { getWalletCallsErrorReply } from './walletSendCallsRpc.js'

// Answers wallet_getCallsStatus for batches that an approved simulation-mode wallet_sendCalls added to the simulation stack. A bundle is reported only to the website's active account on the network of this client, the context it was submitted in, so its receipts and chainId always describe the same network and account. Whether the bundle is known in that context is decided from storage first, and the simulation is requested only for a known bundle, so an unknown or other-context bundle is answered 5730 even when the current network cannot simulate.
export async function getSimulatedCallsStatus(ethereum: EthereumClientService, getSimulationState: () => Promise<ResolvedExecutionSimulationState>, request: WalletGetCallsStatus, websiteOrigin: string, activeAddress: bigint | undefined): Promise<RPCReply> {
	const [id] = request.params
	const unknownBundleReply = getWalletCallsErrorReply(request.method, walletSendCallsUnknownBundleIdError)
	// Without an active account no bundle can match the account it was submitted from.
	if (activeAddress === undefined) return unknownBundleReply
	const requester = { websiteOrigin, account: activeAddress, chainId: ethereum.getChainId() }
	// A bundle is only reported while it exists by the registry's definition, that is, while every one of its calls is on the simulation stack. EIP-5792's status codes describe how submitted calls executed, and a non-atomic status must list receipts for all of them, so a bundle the user removed calls from is no longer the bundle that was submitted and is answered like an unknown one (5730), while its id can be submitted again.
	const bundleTransactionIdentifiers = await getWalletSendCallsBundleForRequester(requester, id)
	if (bundleTransactionIdentifiers === undefined) return unknownBundleReply
	const simulationState = await getSimulationState()
	if (simulationState.kind === 'passthrough') return unknownBundleReply
	const currentState = simulationState.value
	if (currentState.success === false) throw new JsonRpcResponseError(currentState.jsonRpcError)
	const simulatedTransactions = currentState.simulatedBlocks
		.flatMap((block) => block.simulatedTransactions)
		.map((simulatedTransaction) => simulatedTransaction.preSimulationTransaction)
	// The stack can change between the existence check and the simulation, so a call the simulation no longer has is answered like a call without a receipt: as an unknown bundle.
	const batchTransactions = bundleTransactionIdentifiers.map((transactionIdentifier) => simulatedTransactions.find((transaction) => transaction.transactionIdentifier === transactionIdentifier))
	if (batchTransactions.length === 0) return unknownBundleReply
	const receipts: WalletCallsReceipt[] = []
	for (const transaction of batchTransactions) {
		if (transaction === undefined) return unknownBundleReply
		const receipt = await getSimulatedTransactionReceipt(ethereum, undefined, simulationState, transaction.signedTransaction.hash)
		if (receipt === null) return unknownBundleReply
		receipts.push({
			logs: receipt.logs.map((log) => ({ address: log.address, data: log.data, topics: log.topics })),
			status: receipt.status,
			blockHash: receipt.blockHash,
			blockNumber: receipt.blockNumber,
			gasUsed: receipt.gasUsed,
			transactionHash: receipt.transactionHash,
		})
	}
	return {
		type: 'result',
		method: request.method,
		result: {
			version: WALLET_SEND_CALLS_VERSION,
			id,
			chainId: requester.chainId,
			status: getCallsStatusCode(receipts),
			// Simulation-mode batches are separate stack transactions, so they are never atomic.
			atomic: false,
			receipts,
		},
	}
}
