import { EthereumClientService } from './services/EthereumClientService.js'
import { unverifiedApproval } from './protectors/unverifiedApproval.js'
import { selfTokenOops } from './protectors/selfTokenOops.js'
import { EthereumBlockHeader, EthereumUnsignedTransaction, MulticallResponse, MulticallResponseEventLog, SingleMulticallResponse } from '../utils/wire-types.js'
import { TRANSFER_LOG, APPROVAL_LOG, ERC721_APPROVAL_FOR_ALL_LOG, DEPOSIT_LOG, WITHDRAWAL_LOG } from '../utils/constants.js'
import { bytes32String } from '../utils/bigint.js'
import { feeOops } from './protectors/feeOops.js'
import { commonTokenOops } from './protectors/commonTokenOops.js'
import { eoaApproval } from './protectors/eoaApproval.js'
import { eoaCalldata } from './protectors/eoaCalldata.js'
import { tokenToContract } from './protectors/tokenToContract.js'
import { simulatedMulticall } from './services/SimulationModeEthereumClientService.js'
import { WebsiteCreatedEthereumUnsignedTransaction, SimResults, SimulationState, TokenVisualizerResult, VisualizerResult, RpcNetwork } from '../utils/visualizer-types.js'
import { handleApprovalLog, handleDepositLog, handleERC721ApprovalForAllLog, handleTransferLog, handleWithdrawalLog } from './logHandlers.js'
import { QUARANTINE_CODE } from './protectors/quarantine-codes.js'
import { EthereumJSONRpcRequestHandler } from './services/EthereumJSONRpcRequestHandler.js'

const PROTECTORS = [
	selfTokenOops,
	commonTokenOops,
	unverifiedApproval,
	feeOops,
	eoaApproval,
	eoaCalldata,
	tokenToContract
]

type Loghandler = (event: MulticallResponseEventLog) => TokenVisualizerResult

const logHandler = new Map<string, Loghandler >([
	[TRANSFER_LOG, handleTransferLog],
	[APPROVAL_LOG, handleApprovalLog],
	[ERC721_APPROVAL_FOR_ALL_LOG, handleERC721ApprovalForAllLog],
	[DEPOSIT_LOG, handleDepositLog],
	[WITHDRAWAL_LOG, handleWithdrawalLog],
])

export class Simulator {
	public readonly ethereum

	public constructor(rpcNetwork: RpcNetwork, newBlockCallback: (blockHeader: EthereumBlockHeader, ethereumClientService: EthereumClientService) => void, onErrorBlockCallback: (ethereumClientService: EthereumClientService, error: Error) => void) {
		this.ethereum = new EthereumClientService(new EthereumJSONRpcRequestHandler(rpcNetwork), newBlockCallback, onErrorBlockCallback)
	}

	public cleanup = () => {
		this.ethereum.cleanup()
	}

	public async visualizeTransactionChain(simulationState: SimulationState, transactions: WebsiteCreatedEthereumUnsignedTransaction[], blockNumber: bigint, multicallResults: MulticallResponse) {
		let resultPromises: Promise<SimResults>[]= []
		for (let i = 0; i < transactions.length; i++) {
			resultPromises.push(this.visualizeTransaction(simulationState, transactions[i], blockNumber, multicallResults[i]))
		}
		return await Promise.all(resultPromises)
	}

	public async evaluateTransaction(ethereumClientService: EthereumClientService, simulationState: SimulationState, transaction: WebsiteCreatedEthereumUnsignedTransaction, transactionQueue: EthereumUnsignedTransaction[]) {
		const blockNumber = await this.ethereum.getBlockNumber()
		const multicallResults = await simulatedMulticall(ethereumClientService, simulationState, transactionQueue.concat([transaction.transaction]), blockNumber)
		return await this.visualizeTransaction(simulationState, transaction, blockNumber, multicallResults[multicallResults.length - 1])
	}

	public async visualizeTransaction(simulationState: SimulationState, transaction: WebsiteCreatedEthereumUnsignedTransaction, blockNumber: bigint, singleMulticallResponse: SingleMulticallResponse) {
		let quarantine = false
		const quarantineCodesSet = new Set<QUARANTINE_CODE>()
		for (const protectorMethod of PROTECTORS) {
			const reason = await protectorMethod(transaction.transaction, this, simulationState)
			if (reason !== undefined) {
				quarantine = true
				quarantineCodesSet.add(reason)
			}
		}
		let visualizerResults: VisualizerResult | undefined = undefined
		const multicallResult = singleMulticallResponse
		if (multicallResult.statusCode === 'success') {
			const tokenResults = []

			for (const eventLog of multicallResult.events) {
				const logSignature = eventLog.topics[0]
				const handler = logHandler.get(bytes32String(logSignature))
				if (handler) {
					tokenResults.push(handler(eventLog))
				}
			}

			visualizerResults = {
				ethBalanceChanges: multicallResult.balanceChanges,
				tokenResults: tokenResults,
				blockNumber
			}
		}
		const quarantineCodes = Array.from(quarantineCodesSet)
		return {
			quarantine,
			quarantineCodes,
			visualizerResults,
			website: transaction.website,
		}
	}
}
