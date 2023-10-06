import { EthereumClientService } from './services/EthereumClientService.js'
import { selfTokenOops } from './protectors/selfTokenOops.js'
import { EthereumBlockHeader } from '../types/wire-types.js'
import { bytes32String } from '../utils/bigint.js'
import { feeOops } from './protectors/feeOops.js'
import { commonTokenOops } from './protectors/commonTokenOops.js'
import { eoaApproval } from './protectors/eoaApproval.js'
import { eoaCalldata } from './protectors/eoaCalldata.js'
import { tokenToContract } from './protectors/tokenToContract.js'
import { WebsiteCreatedEthereumUnsignedTransaction, SimulationState, TokenVisualizerResult } from '../types/visualizer-types.js'
import { QUARANTINE_CODE } from './protectors/quarantine-codes.js'
import { EthereumJSONRpcRequestHandler } from './services/EthereumJSONRpcRequestHandler.js'
import { MulticallResponseEventLog, SingleMulticallResponse } from '../types/JsonRpc-types.js'
import { APPROVAL_LOG, DEPOSIT_LOG, ERC1155_TRANSFERBATCH_LOG, ERC1155_TRANSFERSINGLE_LOG, ERC721_APPROVAL_FOR_ALL_LOG, TRANSFER_LOG, WITHDRAWAL_LOG } from '../utils/constants.js'
import { handleApprovalLog, handleDepositLog, handleERC1155TransferBatch, handleERC1155TransferSingle, handleERC20TransferLog, handleErc721ApprovalForAllLog, handleWithdrawalLog } from './logHandlers.js'
import { RpcNetwork } from '../types/rpc.js'

const PROTECTORS = [
	selfTokenOops,
	commonTokenOops,
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

export const visualizeTransaction = (blockNumber: bigint, singleMulticallResponse: SingleMulticallResponse) => {
	if (singleMulticallResponse.statusCode !== 'success') return undefined
	let tokenResults: TokenVisualizerResult[] = []
	for (const eventLog of singleMulticallResponse.events) {
		const logSignature = eventLog.topics[0]
		if (logSignature === undefined) continue
		const handler = logHandler.get(bytes32String(logSignature))
		if (handler === undefined) continue
		tokenResults = tokenResults.concat(handler(eventLog))
	}
	return {
		ethBalanceChanges: singleMulticallResponse.balanceChanges,
		tokenResults: tokenResults,
		blockNumber
	}
}

export const runProtectorsForTransaction = async (simulationState: SimulationState, transaction: WebsiteCreatedEthereumUnsignedTransaction, ethereum: EthereumClientService) => {
	const reasonPromises = PROTECTORS.map(async (protectorMethod) => await protectorMethod(transaction.transaction, ethereum, simulationState))
	const reasons: (QUARANTINE_CODE | undefined)[] = await Promise.all(reasonPromises)
	const filteredReasons = reasons.filter((reason): reason is QUARANTINE_CODE => reason !== undefined)
	return {
		quarantine: filteredReasons.length > 0,
		quarantineCodes: Array.from(new Set<QUARANTINE_CODE>(filteredReasons)),
	}
}

/*
const evaluateTransaction = async (ethereumClientService: EthereumClientService, simulationState: SimulationState, transaction: WebsiteCreatedEthereumUnsignedTransaction, transactionQueue: EthereumUnsignedTransaction[]) => {
	const blockNumber = await ethereumClientService.getBlockNumber()
	const multicallResults = await simulatedMulticall(ethereumClientService, simulationState, transactionQueue.concat([transaction.transaction]), blockNumber)
	const multicallResult = multicallResults[multicallResults.length - 1]
	if (multicallResult === undefined) throw new Error('multicall result is too short')
	return visualizeTransaction(transaction, blockNumber, multicallResult)
}*/

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
}
