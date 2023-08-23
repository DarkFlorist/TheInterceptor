import { EthereumClientService } from './services/EthereumClientService.js'
import { unverifiedApproval } from './protectors/unverifiedApproval.js'
import { selfTokenOops } from './protectors/selfTokenOops.js'
import { EthereumBlockHeader, EthereumUnsignedTransaction } from '../utils/wire-types.js'
import { bytes32String } from '../utils/bigint.js'
import { feeOops } from './protectors/feeOops.js'
import { commonTokenOops } from './protectors/commonTokenOops.js'
import { eoaApproval } from './protectors/eoaApproval.js'
import { eoaCalldata } from './protectors/eoaCalldata.js'
import { tokenToContract } from './protectors/tokenToContract.js'
import { simulatedMulticall } from './services/SimulationModeEthereumClientService.js'
import { WebsiteCreatedEthereumUnsignedTransaction, SimResults, SimulationState, VisualizerResult, RpcNetwork, TokenVisualizerResult } from '../utils/visualizer-types.js'
import { QUARANTINE_CODE } from './protectors/quarantine-codes.js'
import { EthereumJSONRpcRequestHandler } from './services/EthereumJSONRpcRequestHandler.js'
import { MulticallResponse, MulticallResponseEventLog, SingleMulticallResponse } from '../utils/JsonRpc-types.js'
import { APPROVAL_LOG, DEPOSIT_LOG, ERC1155_TRANSFERBATCH_LOG, ERC1155_TRANSFERSINGLE_LOG, ERC721_APPROVAL_FOR_ALL_LOG, TRANSFER_LOG, WITHDRAWAL_LOG } from '../utils/constants.js'
import { handleApprovalLog, handleDepositLog, handleERC1155TransferBatch, handleERC1155TransferSingle, handleERC20TransferLog, handleErc721ApprovalForAllLog, handleWithdrawalLog } from './logHandlers.js'

const PROTECTORS = [
	selfTokenOops,
	commonTokenOops,
	unverifiedApproval,
	feeOops,
	eoaApproval,
	eoaCalldata,
	tokenToContract
]

type Loghandler = (event: MulticallResponseEventLog) => TokenVisualizerResult[]

const logHandler = new Map<string, Loghandler>([
	[TRANSFER_LOG, handleERC20TransferLog],
	[APPROVAL_LOG, handleApprovalLog],
	[ERC721_APPROVAL_FOR_ALL_LOG, handleErc721ApprovalForAllLog],
	[DEPOSIT_LOG, handleDepositLog],
	[WITHDRAWAL_LOG, handleWithdrawalLog],
	[ERC1155_TRANSFERBATCH_LOG, handleERC1155TransferBatch],
	[ERC1155_TRANSFERSINGLE_LOG, handleERC1155TransferSingle],
])


export class Simulator {
	public ethereum: EthereumClientService

	public constructor(rpcNetwork: RpcNetwork, newBlockAttemptCallback: (blockHeader: EthereumBlockHeader, ethereumClientService: EthereumClientService, isNewBlock: boolean, simulator: Simulator) => void, onErrorBlockCallback: (ethereumClientService: EthereumClientService) => void) {
		this.ethereum = new EthereumClientService(
			new EthereumJSONRpcRequestHandler(rpcNetwork),
			(blockHeader: EthereumBlockHeader, ethereumClientService: EthereumClientService, isNewBlock: boolean) => newBlockAttemptCallback(blockHeader, ethereumClientService, isNewBlock, this),
			onErrorBlockCallback
		)
	}

	public cleanup = () => this.ethereum.cleanup()

	public reset = (rpcNetwork: RpcNetwork) => {
		this.cleanup()
		this.ethereum = new EthereumClientService(new EthereumJSONRpcRequestHandler(rpcNetwork), this.ethereum.getNewBlockAttemptCallback(), this.ethereum.getOnErrorBlockCallback())
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

		// identify addresses
		let visualizerResults: VisualizerResult | undefined = undefined
		if (singleMulticallResponse.statusCode === 'success') {
			let tokenResults: TokenVisualizerResult[] = []
			for (const eventLog of singleMulticallResponse.events) {
				const logSignature = eventLog.topics[0]
				const handler = logHandler.get(bytes32String(logSignature))
				if (handler === undefined) continue
				tokenResults = tokenResults.concat(handler(eventLog))
			}
			visualizerResults = {
				ethBalanceChanges: singleMulticallResponse.balanceChanges,
				tokenResults: tokenResults,
				blockNumber
			}
		} 
		return {
			quarantine,
			quarantineCodes: Array.from(quarantineCodesSet),
			visualizerResults,
			website: transaction.website,
		}
	}
}
