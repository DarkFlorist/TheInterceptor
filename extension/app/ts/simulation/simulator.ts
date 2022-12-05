import { EthereumClientService } from './services/EthereumClientService'
import { unverifiedApproval } from './protectors/unverifiedApproval'
import { selfTokenOops } from './protectors/selfTokenOops'
import { EthereumUnsignedTransaction, MulticallResponse, MulticallResponseEventLog, SingleMulticallResponse } from '../utils/wire-types'
import { TRANSFER_LOG, APPROVAL_LOG, ERC721_APPROVAL_FOR_ALL_LOG, DEPOSIT_LOG, WITHDRAWAL_LOG, CHAINS } from '../utils/constants'
import { bytes32String } from '../utils/bigint'
import { feeOops } from './protectors/feeOops'
import { commonTokenOops } from './protectors/commonTokenOops'
import { eoaApproval } from './protectors/eoaApproval'
import { eoaCalldata } from './protectors/eoaCalldata'
import { tokenToContract } from './protectors/tokenToContract'
import { SimulationModeEthereumClientService } from './services/SimulationModeEthereumClientService'
import { TokenVisualizerResult, VisualizerResult } from '../utils/visualizer-types'
import { handleApprovalLog, handleDepositLog, handleERC721ApprovalForAllLog, handleTransferLog, handleWithdrawalLog } from './logHandlers'
import { CHAIN } from '../utils/user-interface-types'
import { QUARANTINE_CODE } from './protectors/quarantine-codes'

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
	public readonly simulationModeNode

	public constructor(chain: CHAIN, enableCaching: boolean, newBlockCallback: (blockNumber: bigint) => void ) {
		this.ethereum = new EthereumClientService(CHAINS[chain].https_rpc, chain, enableCaching, newBlockCallback)
		this.simulationModeNode = new SimulationModeEthereumClientService(this.ethereum, CHAINS[chain].wss_rpc)
	}

	public cleanup = () => {
		this.ethereum.cleanup()
	}

	public async visualizeTransactionChain(transactions: EthereumUnsignedTransaction[], blockNumber: bigint, multicallResults: MulticallResponse) {
		let resultPromises = []
		for (let i = 0; i < transactions.length; i++) {
			resultPromises.push(this.visualizeTransaction(transactions[i], blockNumber, multicallResults[i]))
		}
		return Promise.all(resultPromises)
	}

	public async evaluateTransaction(transaction: EthereumUnsignedTransaction, transactionQueue: EthereumUnsignedTransaction[]) {
		const blockNumber = await this.ethereum.getBlockNumber()
		const multicallResults = await this.simulationModeNode.multicall(transactionQueue.concat([transaction]), blockNumber)
		return await this.visualizeTransaction(transaction, blockNumber, multicallResults[multicallResults.length - 1])
	}

	public async visualizeTransaction(transaction: EthereumUnsignedTransaction, blockNumber: bigint, singleMulticallResponse: SingleMulticallResponse) {
		let quarantine = false
		const quarantineCodes = new Set<QUARANTINE_CODE>()
		for (const protectorMethod of PROTECTORS) {
			const reason = await protectorMethod(transaction, this)
			if (reason !== undefined) {
				quarantine = true
				quarantineCodes.add(reason)
			}
		}

		let visualizerResults: VisualizerResult | undefined = undefined
		const multicallResult = singleMulticallResponse
		if (multicallResult.statusCode === 'success') {
			visualizerResults = {
				ethBalanceChanges: multicallResult.balanceChanges,
				tokenResults: [],
				blockNumber
			}

			for (const eventLog of multicallResult.events) {
				const logSignature = eventLog.topics[0]
				const handler = logHandler.get(bytes32String(logSignature))
				if ( handler ) {
					visualizerResults.tokenResults.push(handler(eventLog))
				}
			}
		}

		return {
			quarantine,
			quarantineCodes : Array.from(quarantineCodes),
			visualizerResults,
		}
	}
}
