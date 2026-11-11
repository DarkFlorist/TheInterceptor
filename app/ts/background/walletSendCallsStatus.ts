import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { getSimulatedTransactionReceipt } from '../simulation/services/SimulationModeEthereumClientService.js'
import type { RPCReply } from '../types/interceptor-messages.js'
import { WALLET_SEND_CALLS_VERSION, type WalletCallsReceipt, type WalletGetCallsStatus } from '../types/JsonRpc-types.js'
import type { ResolvedExecutionSimulationState } from '../types/visualizer-types.js'
import { JsonRpcResponseError } from '../utils/errors.js'
import { getCallsStatusCode, walletSendCallsUnknownBundleIdError } from './walletSendCalls.js'
import { getWalletSendCallsBatchTransactionIdentifiers, isWalletSendCallsBundleOnStack } from './walletSendCallsBatchIds.js'
import { getWalletCallsErrorReply } from './walletSendCallsRpc.js'

// Answers wallet_getCallsStatus for batches that an approved simulation-mode wallet_sendCalls added to the simulation stack. A bundle is reported only to the website's active account on the network of this client, the context it was submitted in, so its receipts and chainId always describe the same network and account.
export async function getSimulatedCallsStatus(ethereum: EthereumClientService, simulationState: ResolvedExecutionSimulationState, request: WalletGetCallsStatus, websiteOrigin: string, activeAddress: bigint | undefined): Promise<RPCReply> {
	const [id] = request.params
	const unknownBundleReply = getWalletCallsErrorReply(request.method, walletSendCallsUnknownBundleIdError)
	// Without an active account no bundle can match the account it was submitted from.
	if (simulationState.kind === 'passthrough' || activeAddress === undefined) return unknownBundleReply
	const currentState = simulationState.value
	if (currentState.success === false) throw new JsonRpcResponseError(currentState.jsonRpcError)
	const requester = { websiteOrigin, account: activeAddress, chainId: ethereum.getChainId() }
	const batchTransactionIdentifiers = await getWalletSendCallsBatchTransactionIdentifiers(requester, id)
	if (batchTransactionIdentifiers === undefined) return unknownBundleReply
	const stackTransactions = currentState.simulatedBlocks
		.flatMap((block) => block.simulatedTransactions)
		.map((simulatedTransaction) => simulatedTransaction.preSimulationTransaction)
	// A bundle is only reported while it exists by the registry's definition, that is, while every one of its calls is on the simulation stack. EIP-5792's status codes describe how submitted calls executed, and a non-atomic status must list receipts for all of them, so a bundle the user removed calls from is no longer the bundle that was submitted and is answered like an unknown one (5730), while its id can be submitted again.
	if (!isWalletSendCallsBundleOnStack(batchTransactionIdentifiers, stackTransactions.map((transaction) => transaction.transactionIdentifier))) return unknownBundleReply
	const batchTransactions = stackTransactions.filter((transaction) => batchTransactionIdentifiers.includes(transaction.transactionIdentifier))
	if (batchTransactions.length === 0) return unknownBundleReply
	const receipts: WalletCallsReceipt[] = []
	for (const transaction of batchTransactions) {
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
